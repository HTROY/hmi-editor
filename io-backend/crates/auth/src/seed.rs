//! First-boot admin seeding.

use crate::service::AuthService;
use hmi_io_db::repo::Repo;
use rand::distributions::Alphanumeric;
use rand::rngs::OsRng;
use rand::Rng;

/// Seed the initial `admin` user with a random password when the user table is
/// empty. Returns the plaintext password (for one-time startup logging), or
/// `None` when seeding was skipped.
pub fn ensure_admin_seeded(repo: &Repo) -> anyhow::Result<Option<String>> {
    if repo.user_count()? > 0 {
        return Ok(None);
    }
    let password: String = OsRng
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect();
    let hash = AuthService::hash_password(&password)?;
    repo.create_user("admin", &hash, "admin", true)?;
    Ok(Some(password))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_db::repo::Repo;

    #[test]
    fn ensure_admin_seeded_creates_admin_with_random_password_once() {
        let repo = Repo::new(":memory:").unwrap();
        let password = ensure_admin_seeded(&repo).unwrap().unwrap();
        assert!(!password.is_empty());

        let user = repo.get_user("admin").unwrap().unwrap();
        assert_eq!(user.role, "admin");
        assert!(user.must_change_password);
        assert!(crate::AuthService::verify_password(
            &user.password_hash,
            &password
        ));

        assert!(ensure_admin_seeded(&repo).unwrap().is_none());
        assert_eq!(repo.user_count().unwrap(), 1);
    }
}
