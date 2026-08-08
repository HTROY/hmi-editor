//! JWT issuance/verification, Argon2id password hashing and login flows.

use crate::model::{AuthError, AuthUser, Claims, LoginOutcome, Role, TokenPair};
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use hmi_io_db::repo::Repo;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::distributions::Alphanumeric;
use rand::Rng;

/// Access token lifetime (30 minutes).
pub const ACCESS_TOKEN_TTL_SECS: u64 = 30 * 60;
/// Refresh token lifetime (7 days).
pub const REFRESH_TOKEN_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// Minimum accepted password length.
pub const MIN_PASSWORD_LEN: usize = 8;

const MIN_SECRET_LEN: usize = 32;

pub struct AuthService {
    secret: String,
}

impl AuthService {
    /// Create a service with the given signing secret (min 32 chars).
    pub fn new(secret: impl Into<String>) -> anyhow::Result<Self> {
        let secret = secret.into();
        if secret.len() < MIN_SECRET_LEN {
            anyhow::bail!("JWT secret must be at least {} characters", MIN_SECRET_LEN);
        }
        Ok(Self { secret })
    }

    /// Resolve the signing secret from `HMI_JWT_SECRET` or the persisted
    /// `jwt_secret` server config, generating and storing one on first start.
    pub fn for_repo(repo: &Repo) -> anyhow::Result<Self> {
        let mut secret = std::env::var("HMI_JWT_SECRET").unwrap_or_default();
        if secret.trim().is_empty() {
            secret = repo.get_config("jwt_secret").unwrap_or_default();
        }
        if secret.len() < MIN_SECRET_LEN {
            secret = random_secret();
            repo.set_config("jwt_secret", &secret)?;
        }
        Self::new(secret)
    }

    /// Hash a password with Argon2id and return the PHC string.
    pub fn hash_password(password: &str) -> anyhow::Result<String> {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!("password hashing failed: {}", e))?;
        Ok(hash.to_string())
    }

    /// Verify a password against an Argon2id PHC hash.
    pub fn verify_password(hash: &str, password: &str) -> bool {
        let Ok(parsed) = PasswordHash::new(hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    /// Authenticate a user and issue a fresh access/refresh token pair.
    pub fn login(
        &self,
        repo: &Repo,
        username: &str,
        password: &str,
    ) -> Result<LoginOutcome, AuthError> {
        let row = repo
            .get_user(username)
            .map_err(internal)?
            .ok_or(AuthError::InvalidCredentials)?;
        if !Self::verify_password(&row.password_hash, password) {
            return Err(AuthError::InvalidCredentials);
        }
        let role = parse_role(&row.role).ok_or(AuthError::Internal)?;
        let pair = self.issue_tokens(
            &row.username,
            role,
            row.must_change_password,
            row.token_version,
        )?;
        Ok(LoginOutcome {
            access_token: pair.access_token,
            refresh_token: pair.refresh_token,
            token_type: "bearer".into(),
            role,
            must_change_password: row.must_change_password,
        })
    }

    /// Exchange a valid refresh token for a new access/refresh pair.
    pub fn refresh(&self, repo: &Repo, refresh_token: &str) -> Result<TokenPair, AuthError> {
        let claims = self.verify_token(refresh_token, "refresh")?;
        let row = repo
            .get_user(&claims.sub)
            .map_err(internal)?
            .ok_or(AuthError::InvalidToken)?;
        if row.token_version != claims.ver {
            return Err(AuthError::InvalidToken);
        }
        let role = parse_role(&claims.role).ok_or(AuthError::InvalidToken)?;
        self.issue_tokens(
            &claims.sub,
            role,
            claims.must_change_password,
            row.token_version,
        )
    }

    /// Verify the old password and issue a fresh token pair with the new one.
    pub fn change_password(
        &self,
        repo: &Repo,
        username: &str,
        old_password: &str,
        new_password: &str,
    ) -> Result<TokenPair, AuthError> {
        if new_password.len() < MIN_PASSWORD_LEN {
            return Err(AuthError::WeakPassword);
        }
        let row = repo
            .get_user(username)
            .map_err(internal)?
            .ok_or(AuthError::InvalidCredentials)?;
        if !Self::verify_password(&row.password_hash, old_password) {
            return Err(AuthError::InvalidCredentials);
        }
        let hash = Self::hash_password(new_password).map_err(internal)?;
        let version = repo
            .update_user_password(username, &hash, false)
            .map_err(internal)?;
        let role = parse_role(&row.role).ok_or(AuthError::Internal)?;
        self.issue_tokens(username, role, false, version)
    }

    /// Verify an access token and return its authenticated principal.
    pub fn authenticate(&self, access_token: &str) -> Result<AuthUser, AuthError> {
        let claims = self.verify_token(access_token, "access")?;
        let role = parse_role(&claims.role).ok_or(AuthError::InvalidToken)?;
        Ok(AuthUser {
            username: claims.sub,
            role,
            must_change_password: claims.must_change_password,
        })
    }

    fn issue_tokens(
        &self,
        username: &str,
        role: Role,
        must_change: bool,
        ver: u64,
    ) -> Result<TokenPair, AuthError> {
        let now = jsonwebtoken::get_current_timestamp() as usize;
        let access = self.sign(Claims {
            sub: username.into(),
            role: role.to_string(),
            must_change_password: must_change,
            typ: "access".into(),
            jti: random_token_id(),
            ver,
            iat: now,
            exp: now + ACCESS_TOKEN_TTL_SECS as usize,
        })?;
        let refresh = self.sign(Claims {
            sub: username.into(),
            role: role.to_string(),
            must_change_password: must_change,
            typ: "refresh".into(),
            jti: random_token_id(),
            ver,
            iat: now,
            exp: now + REFRESH_TOKEN_TTL_SECS as usize,
        })?;
        Ok(TokenPair {
            access_token: access,
            refresh_token: refresh,
            token_type: "bearer".into(),
        })
    }

    fn sign(&self, claims: Claims) -> Result<String, AuthError> {
        encode(
            &Header::new(jsonwebtoken::Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.secret.as_bytes()),
        )
        .map_err(internal)
    }

    fn verify_token(&self, token: &str, expected_type: &str) -> Result<Claims, AuthError> {
        let claims = decode::<Claims>(token, &DecodingKey::from_secret(self.secret.as_bytes()), &{
            let mut v = Validation::new(jsonwebtoken::Algorithm::HS256);
            v.leeway = 0;
            v
        })
        .map_err(|e| {
            log::debug!("JWT verification failed: {}", e);
            AuthError::InvalidToken
        })?
        .claims;
        if claims.typ != expected_type {
            return Err(AuthError::InvalidToken);
        }
        Ok(claims)
    }
}

fn random_secret() -> String {
    OsRng
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn random_token_id() -> String {
    OsRng
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect()
}

fn parse_role(role: &str) -> Option<Role> {
    role.parse().ok()
}

fn internal(e: impl std::fmt::Display) -> AuthError {
    log::error!("{}", e);
    AuthError::Internal
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_db::repo::Repo;

    const SECRET: &str = "test-secret-0123456789-0123456789-0123456789";

    fn service() -> AuthService {
        AuthService::new(SECRET).unwrap()
    }

    fn repo() -> Repo {
        Repo::new(":memory:").unwrap()
    }

    fn add_user(repo: &Repo, username: &str, role: Role, must_change: bool) {
        let hash = AuthService::hash_password("correct-horse-battery").unwrap();
        repo.create_user(username, &hash, &role.to_string(), must_change)
            .unwrap();
    }

    #[test]
    fn login_issues_tokens_for_valid_credentials() {
        let repo = repo();
        add_user(&repo, "alice", Role::Engineer, true);
        let auth = service();

        let out = auth.login(&repo, "alice", "correct-horse-battery").unwrap();
        assert_eq!(out.role, Role::Engineer);
        assert!(out.must_change_password);
        assert_eq!(out.token_type, "bearer");
        assert!(!out.access_token.is_empty());
        assert!(!out.refresh_token.is_empty());

        let user = auth.authenticate(&out.access_token).unwrap();
        assert_eq!(user.username, "alice");
        assert_eq!(user.role, Role::Engineer);
        assert!(user.must_change_password);
    }

    #[test]
    fn login_rejects_wrong_password_and_missing_user() {
        let repo = repo();
        add_user(&repo, "alice", Role::Admin, false);
        let auth = service();

        assert_eq!(
            auth.login(&repo, "alice", "wrong-password").unwrap_err(),
            AuthError::InvalidCredentials
        );
        assert_eq!(
            auth.login(&repo, "nobody", "correct-horse-battery")
                .unwrap_err(),
            AuthError::InvalidCredentials
        );
    }

    #[test]
    fn refresh_issues_fresh_pair_and_new_access_works() {
        let repo = repo();
        add_user(&repo, "bob", Role::Operator, false);
        let auth = service();
        let first = auth.login(&repo, "bob", "correct-horse-battery").unwrap();

        let pair = auth.refresh(&repo, &first.refresh_token).unwrap();
        assert_ne!(pair.access_token, first.access_token);
        assert_ne!(pair.refresh_token, first.refresh_token);

        let user = auth.authenticate(&pair.access_token).unwrap();
        assert_eq!(user.username, "bob");
        assert!(!user.must_change_password);
    }

    #[test]
    fn refresh_rejects_access_token_and_garbage() {
        let repo = repo();
        add_user(&repo, "bob", Role::Admin, false);
        let auth = service();
        let out = auth.login(&repo, "bob", "correct-horse-battery").unwrap();

        assert_eq!(
            auth.refresh(&repo, &out.access_token).unwrap_err(),
            AuthError::InvalidToken
        );
        assert_eq!(
            auth.refresh(&repo, "not-a-token").unwrap_err(),
            AuthError::InvalidToken
        );
    }

    #[test]
    fn authenticate_rejects_expired_access_token() {
        let auth = service();
        let now = jsonwebtoken::get_current_timestamp() as usize;
        let claims = Claims {
            sub: "old".into(),
            role: "admin".into(),
            must_change_password: false,
            typ: "access".into(),
            jti: "test".into(),
            ver: 1,
            iat: now - 120,
            exp: now - 60,
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();

        assert_eq!(
            auth.authenticate(&token).unwrap_err(),
            AuthError::InvalidToken
        );
    }

    #[test]
    fn change_password_requires_old_password_and_clears_flag() {
        let repo = repo();
        add_user(&repo, "carol", Role::Viewer, true);
        let auth = service();

        assert_eq!(
            auth.change_password(&repo, "carol", "wrong-old", "new-password-123")
                .unwrap_err(),
            AuthError::InvalidCredentials
        );
        assert_eq!(
            auth.change_password(&repo, "carol", "correct-horse-battery", "short")
                .unwrap_err(),
            AuthError::WeakPassword
        );

        let pair = auth
            .change_password(&repo, "carol", "correct-horse-battery", "new-password-123")
            .unwrap();
        let user = auth.authenticate(&pair.access_token).unwrap();
        assert_eq!(user.username, "carol");
        assert!(!user.must_change_password);
        let row = repo.get_user("carol").unwrap().unwrap();
        assert!(!row.must_change_password);
        assert_eq!(
            auth.login(&repo, "carol", "new-password-123")
                .unwrap()
                .must_change_password,
            false
        );
        assert_eq!(
            auth.login(&repo, "carol", "correct-horse-battery")
                .unwrap_err(),
            AuthError::InvalidCredentials
        );
    }

    #[test]
    fn refresh_rejects_token_issued_before_password_change() {
        let repo = repo();
        add_user(&repo, "dave", Role::Engineer, false);
        let auth = service();
        let first = auth.login(&repo, "dave", "correct-horse-battery").unwrap();

        let pair = auth
            .change_password(&repo, "dave", "correct-horse-battery", "new-password-456")
            .unwrap();
        assert_eq!(
            auth.refresh(&repo, &first.refresh_token).unwrap_err(),
            AuthError::InvalidToken
        );
        assert_eq!(
            auth.refresh(&repo, &pair.refresh_token)
                .unwrap()
                .access_token
                .len()
                > 0,
            true
        );
    }
}
