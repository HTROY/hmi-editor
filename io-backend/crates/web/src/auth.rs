//! REST handlers for login, token refresh and password change.

use crate::api::AppState;
use axum::extract::{Extension, State};
use axum::response::Json;
use hmi_io_auth::{AuthError, AuthService, AuthUser, LoginOutcome, TokenPair};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

pub async fn login(
    State(repo): State<AppState>,
    Extension(auth): Extension<Arc<AuthService>>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginOutcome>, AuthError> {
    auth.login(&repo, &body.username, &body.password).map(Json)
}

pub async fn refresh(
    State(repo): State<AppState>,
    Extension(auth): Extension<Arc<AuthService>>,
    Json(body): Json<RefreshRequest>,
) -> Result<Json<TokenPair>, AuthError> {
    auth.refresh(&repo, &body.refresh_token).map(Json)
}

pub async fn change_password(
    State(repo): State<AppState>,
    Extension(auth): Extension<Arc<AuthService>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<TokenPair>, AuthError> {
    auth.change_password(
        &repo,
        &user.username,
        &body.old_password,
        &body.new_password,
    )
    .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{auth_routes, project_routes};
    use crate::test_utils::{make_zip, store, StoreFixture};
    use axum::body::Body;
    use axum::http::StatusCode;
    use axum::http::{header, Request};
    use axum::Router;
    use hmi_io_auth::{ensure_admin_seeded, Role};
    use hmi_io_db::repo::Repo;
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    const SECRET: &str = "test-secret-0123456789-0123456789-0123456789";

    fn test_app(repo: Arc<Repo>, auth: Arc<AuthService>) -> (Router, StoreFixture) {
        let fixture = store();
        let app = auth_routes(auth.clone())
            .merge(project_routes(fixture.store.clone(), auth))
            .with_state(repo);
        (app, fixture)
    }

    async fn send(
        app: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let bytes = body
            .map(|v| serde_json::to_vec(&v).unwrap())
            .unwrap_or_default();
        send_bytes(app, method, uri, token, bytes).await
    }

    async fn send_bytes(
        app: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        bytes: Vec<u8>,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {}", token));
        }
        if !bytes.is_empty() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let res = app
            .clone()
            .oneshot(builder.body(Body::from(bytes)).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    fn make_user(repo: &Repo, username: &str, role: Role) {
        let hash = AuthService::hash_password("correct-horse-battery").unwrap();
        repo.create_user(username, &hash, &role.to_string(), false)
            .unwrap();
    }

    #[tokio::test]
    async fn login_refresh_and_forced_password_change_flow() {
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let initial_password = ensure_admin_seeded(&repo).unwrap().unwrap();
        let auth = Arc::new(AuthService::new(SECRET).unwrap());
        let (app, _fixture) = test_app(repo.clone(), auth.clone());

        let (status, body) = send(
            &app,
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"username": "admin", "password": initial_password})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["must_change_password"], true);
        let access = body["access_token"].as_str().unwrap();
        let refresh = body["refresh_token"].as_str().unwrap();

        let (status, _) = send(&app, "GET", "/api/projects", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, _) = send(&app, "GET", "/api/projects", Some(access), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = send(
            &app,
            "POST",
            "/api/auth/change-password",
            Some(access),
            Some(json!({"old_password": initial_password, "new_password": "brand-new-pass-1"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let new_access = body["access_token"].as_str().unwrap().to_string();
        let new_refresh = body["refresh_token"].as_str().unwrap().to_string();

        let (status, body) = send(&app, "GET", "/api/projects", Some(&new_access), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!([]));

        let (status, body) = send(
            &app,
            "POST",
            "/api/auth/refresh",
            None,
            Some(json!({"refresh_token": new_refresh})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let refreshed_access = body["access_token"].as_str().unwrap().to_string();
        let (status, _) = send(&app, "GET", "/api/projects", Some(&refreshed_access), None).await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = send(
            &app,
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"username": "admin", "password": initial_password})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(
            auth.refresh(&repo, refresh).is_err(),
            "pre-change refresh stays blocked"
        );
    }

    #[tokio::test]
    async fn project_api_enforces_permission_matrix() {
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let auth = Arc::new(AuthService::new(SECRET).unwrap());
        let (app, _fixture) = test_app(repo.clone(), auth.clone());

        for (username, role) in [
            ("eng", Role::Engineer),
            ("op", Role::Operator),
            ("view", Role::Viewer),
        ] {
            make_user(&repo, username, role);
        }

        let eng = auth
            .login(&repo, "eng", "correct-horse-battery")
            .unwrap()
            .access_token;
        let op = auth
            .login(&repo, "op", "correct-horse-battery")
            .unwrap()
            .access_token;
        let view = auth
            .login(&repo, "view", "correct-horse-battery")
            .unwrap()
            .access_token;

        let (status, _) = send_bytes(&app, "PUT", "/api/projects/demo", None, vec![]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, _) = send_bytes(&app, "PUT", "/api/projects/demo", Some(&view), vec![]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(&app, "GET", "/api/projects", Some(&view), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = send_bytes(&app, "PUT", "/api/projects/demo", Some(&op), vec![]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(&app, "GET", "/api/projects", Some(&op), None).await;
        assert_eq!(status, StatusCode::OK);

        let zip = make_zip("v1");
        let (status, _) = send_bytes(&app, "PUT", "/api/projects/demo", Some(&eng), zip).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = send(&app, "GET", "/api/projects", Some(&eng), None).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn audit_log_records_jwt_actor() {
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let auth = Arc::new(AuthService::new(SECRET).unwrap());
        let (app, fixture) = test_app(repo.clone(), auth.clone());
        make_user(&repo, "eng", Role::Engineer);
        make_user(&repo, "admin", Role::Admin);
        let eng = auth
            .login(&repo, "eng", "correct-horse-battery")
            .unwrap()
            .access_token;
        let admin = auth
            .login(&repo, "admin", "correct-horse-battery")
            .unwrap()
            .access_token;

        let zip = make_zip("v1");
        let (status, _) =
            send_bytes(&app, "PUT", "/api/projects/audit-demo", Some(&eng), zip).await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = send(
            &app,
            "DELETE",
            "/api/projects/audit-demo",
            Some(&admin),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let audit = fixture.repo.list_audit_logs(Some("audit-demo")).unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].action, "project_push");
        assert_eq!(audit[0].actor, "eng");
        assert_eq!(audit[1].action, "project_delete");
        assert_eq!(audit[1].actor, "admin");
    }
}
