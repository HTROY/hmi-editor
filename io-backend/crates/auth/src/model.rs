//! Auth domain types, permission matrix and reusable axum middleware.

use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// Backend user role; drives the project permission matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Full access: read/write/delete projects.
    Admin,
    /// Can read/write/delete projects.
    Engineer,
    /// Read-only project access.
    Operator,
    /// No project access.
    Viewer,
}

impl Role {
    /// Whether the role may read project metadata and packages.
    pub fn can_read_projects(self) -> bool {
        matches!(self, Role::Admin | Role::Engineer | Role::Operator)
    }

    /// Whether the role may push or delete projects.
    pub fn can_write_projects(self) -> bool {
        matches!(self, Role::Admin | Role::Engineer)
    }
}

impl FromStr for Role {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "admin" => Ok(Role::Admin),
            "engineer" => Ok(Role::Engineer),
            "operator" => Ok(Role::Operator),
            "viewer" => Ok(Role::Viewer),
            _ => Err(()),
        }
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Role::Admin => "admin",
            Role::Engineer => "engineer",
            Role::Operator => "operator",
            Role::Viewer => "viewer",
        };
        f.write_str(s)
    }
}

/// Authenticated principal resolved from a verified access token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthUser {
    pub username: String,
    pub role: Role,
    pub must_change_password: bool,
}

impl AuthUser {
    /// Grant project read access, or reject until the password is changed.
    pub fn require_project_read(&self) -> Result<(), AuthError> {
        if self.must_change_password {
            return Err(AuthError::MustChangePassword);
        }
        if !self.role.can_read_projects() {
            return Err(AuthError::Forbidden);
        }
        Ok(())
    }

    /// Grant project write access, or reject until the password is changed.
    pub fn require_project_write(&self) -> Result<(), AuthError> {
        if self.must_change_password {
            return Err(AuthError::MustChangePassword);
        }
        if !self.role.can_write_projects() {
            return Err(AuthError::Forbidden);
        }
        Ok(())
    }
}

/// JWT payload claims issued by the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub role: String,
    pub must_change_password: bool,
    pub typ: String,
    pub jti: String,
    pub ver: u64,
    pub iat: usize,
    pub exp: usize,
}

/// Fresh access and refresh tokens returned by login/refresh endpoints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
}

/// Login response payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginOutcome {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub role: Role,
    pub must_change_password: bool,
}

/// Auth failures rendered as HTTP responses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    MissingToken,
    InvalidToken,
    InvalidCredentials,
    WeakPassword,
    MustChangePassword,
    Forbidden,
    Internal,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AuthError::MissingToken | AuthError::InvalidToken => {
                (StatusCode::UNAUTHORIZED, "unauthorized")
            }
            AuthError::InvalidCredentials => (StatusCode::UNAUTHORIZED, "invalid credentials"),
            AuthError::WeakPassword => (StatusCode::BAD_REQUEST, "weak password"),
            AuthError::MustChangePassword => (StatusCode::FORBIDDEN, "password change required"),
            AuthError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AuthError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
        };
        (status, axum::Json(serde_json::json!({ "error": message }))).into_response()
    }
}

/// Reusable auth middleware: resolves the Bearer token into an `AuthUser`
/// request extension, rejecting missing/invalid/expired tokens with 401.
pub async fn require_auth(
    axum::extract::State(auth): axum::extract::State<std::sync::Arc<crate::service::AuthService>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AuthError> {
    let token = bearer_token(&request).ok_or(AuthError::MissingToken)?;
    let user = auth.authenticate(&token)?;
    let mut request = request;
    request.extensions_mut().insert(user);
    Ok(next.run(request).await)
}

/// Reusable permission middleware for project routes: GET/HEAD need read
/// permission, all other methods need write permission.
pub async fn require_project_permission(
    axum::extract::Extension(user): axum::extract::Extension<AuthUser>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AuthError> {
    if request.method() == Method::GET || request.method() == Method::HEAD {
        user.require_project_read()?;
    } else {
        user.require_project_write()?;
    }
    Ok(next.run(request).await)
}

pub(crate) fn bearer_token(request: &Request<axum::body::Body>) -> Option<String> {
    request
        .headers()
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::AuthService;
    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;
    use hmi_io_db::repo::Repo;
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    const SECRET: &str = "test-secret-0123456789-0123456789-0123456789";

    #[test]
    fn permission_matrix_matches_spec() {
        let admin = AuthUser {
            username: "admin".into(),
            role: Role::Admin,
            must_change_password: false,
        };
        let engineer = AuthUser {
            username: "eng".into(),
            role: Role::Engineer,
            must_change_password: false,
        };
        let operator = AuthUser {
            username: "op".into(),
            role: Role::Operator,
            must_change_password: false,
        };
        let viewer = AuthUser {
            username: "view".into(),
            role: Role::Viewer,
            must_change_password: false,
        };

        for user in [&admin, &engineer, &operator] {
            assert_eq!(
                user.require_project_read(),
                Ok(()),
                "{} can read",
                user.username
            );
        }
        assert_eq!(viewer.require_project_read(), Err(AuthError::Forbidden));

        for user in [&admin, &engineer] {
            assert_eq!(
                user.require_project_write(),
                Ok(()),
                "{} can write",
                user.username
            );
        }
        for user in [&operator, &viewer] {
            assert_eq!(
                user.require_project_write(),
                Err(AuthError::Forbidden),
                "{} cannot write",
                user.username
            );
        }
    }

    #[test]
    fn must_change_password_blocks_project_access() {
        let user = AuthUser {
            username: "admin".into(),
            role: Role::Admin,
            must_change_password: true,
        };
        assert_eq!(
            user.require_project_read(),
            Err(AuthError::MustChangePassword)
        );
        assert_eq!(
            user.require_project_write(),
            Err(AuthError::MustChangePassword)
        );
    }

    #[test]
    fn role_parses_lowercase_and_rejects_unknown() {
        assert_eq!("admin".parse::<Role>(), Ok(Role::Admin));
        assert_eq!("ENGINEER".parse::<Role>(), Ok(Role::Engineer));
        assert_eq!("operator".parse::<Role>(), Ok(Role::Operator));
        assert_eq!("viewer".parse::<Role>(), Ok(Role::Viewer));
        assert!("root".parse::<Role>().is_err());
    }

    fn test_app(auth: Arc<AuthService>) -> Router {
        Router::new()
            .route(
                "/projects",
                get(|| async { StatusCode::OK }).put(|| async { StatusCode::OK }),
            )
            .layer(axum::middleware::from_fn(require_project_permission))
            .layer(axum::middleware::from_fn_with_state(
                auth.clone(),
                require_auth,
            ))
            .layer(axum::extract::Extension(auth))
    }

    async fn request_status(app: Router, method: &str, token: Option<&str>) -> StatusCode {
        let mut builder = axum::http::Request::builder()
            .method(method)
            .uri("/projects");
        if let Some(token) = token {
            builder = builder.header(
                axum::http::header::AUTHORIZATION,
                format!("Bearer {}", token),
            );
        }
        let res = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let _ = res.into_body().collect().await.unwrap();
        status
    }

    fn login_token(auth: &AuthService, repo: &Repo, username: &str) -> String {
        let hash = AuthService::hash_password("correct-horse-battery").unwrap();
        let role = match username {
            "admin" => Role::Admin,
            "eng" => Role::Engineer,
            "op" => Role::Operator,
            "view" => Role::Viewer,
            _ => Role::Viewer,
        };
        repo.create_user(username, &hash, &role.to_string(), false)
            .unwrap();
        auth.login(repo, username, "correct-horse-battery")
            .unwrap()
            .access_token
    }

    #[tokio::test]
    async fn require_auth_rejects_missing_and_invalid_tokens() {
        let auth = Arc::new(AuthService::new(SECRET).unwrap());
        let app = test_app(auth);

        assert_eq!(
            request_status(app.clone(), "GET", None).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_status(app, "GET", Some("not-a-token")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn middleware_enforces_project_permission_matrix() {
        let repo = Repo::new(":memory:").unwrap();
        let auth = Arc::new(AuthService::new(SECRET).unwrap());
        let app = test_app(auth.clone());

        let admin = login_token(&auth, &repo, "admin");
        let eng = login_token(&auth, &repo, "eng");
        let op = login_token(&auth, &repo, "op");
        let view = login_token(&auth, &repo, "view");

        assert_eq!(
            request_status(app.clone(), "GET", Some(&admin)).await,
            StatusCode::OK
        );
        assert_eq!(
            request_status(app.clone(), "GET", Some(&eng)).await,
            StatusCode::OK
        );
        assert_eq!(
            request_status(app.clone(), "GET", Some(&op)).await,
            StatusCode::OK
        );
        assert_eq!(
            request_status(app.clone(), "GET", Some(&view)).await,
            StatusCode::FORBIDDEN
        );

        assert_eq!(
            request_status(app.clone(), "PUT", Some(&admin)).await,
            StatusCode::OK
        );
        assert_eq!(
            request_status(app.clone(), "PUT", Some(&eng)).await,
            StatusCode::OK
        );
        assert_eq!(
            request_status(app.clone(), "PUT", Some(&op)).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request_status(app.clone(), "PUT", Some(&view)).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn middleware_blocks_project_access_until_password_changed() {
        let repo = Repo::new(":memory:").unwrap();
        let hash = AuthService::hash_password("correct-horse-battery").unwrap();
        repo.create_user("newbie", &hash, "admin", true).unwrap();
        let auth = Arc::new(AuthService::new(SECRET).unwrap());
        let token = auth
            .login(&repo, "newbie", "correct-horse-battery")
            .unwrap()
            .access_token;

        let status = request_status(test_app(auth), "GET", Some(&token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
