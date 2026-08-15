//! User account CRUD tests.

use crate::repo::Repo;

#[tokio::test]
async fn user_create_and_get_round_trips_role_and_must_change() {
    let repo = Repo::new(":memory:").await.unwrap();
    let id = repo
        .create_user(
            "admin",
            "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash",
            "admin",
            true,
        )
        .await
        .unwrap();
    assert!(id > 0);

    let user = repo.get_user("admin").await.unwrap().unwrap();
    assert_eq!(user.username, "admin");
    assert_eq!(
        user.password_hash,
        "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash"
    );
    assert_eq!(user.role, "admin");
    assert!(user.must_change_password);

    assert!(repo.get_user("missing").await.unwrap().is_none());
}

#[tokio::test]
async fn update_user_password_replaces_hash_and_clears_must_change() {
    let repo = Repo::new(":memory:").await.unwrap();
    repo.create_user("engineer", "old-hash", "engineer", true)
        .await
        .unwrap();

    repo.update_user_password("engineer", "new-hash", false)
        .await
        .unwrap();

    let user = repo.get_user("engineer").await.unwrap().unwrap();
    assert_eq!(user.password_hash, "new-hash");
    assert!(!user.must_change_password);
    assert_eq!(user.token_version, 2);
}

#[tokio::test]
async fn user_count_starts_zero_and_tracks_rows() {
    let repo = Repo::new(":memory:").await.unwrap();
    assert_eq!(repo.user_count().await.unwrap(), 0);
    repo.create_user("op", "h", "operator", false)
        .await
        .unwrap();
    repo.create_user("viewer", "h", "viewer", false)
        .await
        .unwrap();
    assert_eq!(repo.user_count().await.unwrap(), 2);
}
