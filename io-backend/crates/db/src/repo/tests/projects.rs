//! Project storage & audit tests.

use crate::repo::Repo;

#[tokio::test]
async fn project_push_creates_then_bumps_with_optimistic_lock() {
    let repo = Repo::new(":memory:").await.unwrap();
    let res = repo
        .push_project("proj-1", None, "Line 1", 1, 123, "", "create")
        .await
        .unwrap()
        .unwrap();
    assert!(res.created);
    assert_eq!(res.version, 1);

    let row = repo.get_project("proj-1").await.unwrap().unwrap();
    assert_eq!(row.name, "Line 1");
    assert_eq!(row.schema_version, 1);
    assert_eq!(row.version, 1);
    assert_eq!(row.size_bytes, 123);

    let res = repo
        .push_project("proj-1", Some(1), "Line 1 v2", 1, 200, "alice", "update")
        .await
        .unwrap()
        .unwrap();
    assert!(!res.created);
    assert_eq!(res.version, 2);

    // Stale version, missing version, and create-with-nonzero-version all lose the lock.
    assert!(repo
        .push_project("proj-1", Some(1), "stale", 1, 1, "", "")
        .await
        .unwrap()
        .is_none());
    assert!(repo
        .push_project("proj-1", None, "no-version", 1, 1, "", "")
        .await
        .unwrap()
        .is_none());
    assert!(repo
        .push_project("missing", Some(3), "x", 1, 1, "", "")
        .await
        .unwrap()
        .is_none());

    let audit = repo.list_audit_logs(Some("proj-1")).await.unwrap();
    assert_eq!(audit.len(), 2);
    assert!(audit.iter().all(|e| e.action == "project_push"));
    assert_eq!(audit[0].version, 1);
    assert_eq!(audit[1].version, 2);
}

#[tokio::test]
async fn project_delete_writes_audit_and_returns_row() {
    let repo = Repo::new(":memory:").await.unwrap();
    repo.push_project("proj-2", None, "P2", 1, 10, "", "create")
        .await
        .unwrap();

    let deleted = repo
        .delete_project("proj-2", "op", "user removed")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(deleted.id, "proj-2");
    assert_eq!(deleted.version, 1);
    assert!(repo.get_project("proj-2").await.unwrap().is_none());
    assert!(repo
        .delete_project("proj-2", "", "")
        .await
        .unwrap()
        .is_none());

    let audit = repo.list_audit_logs(Some("proj-2")).await.unwrap();
    assert_eq!(audit.len(), 2);
    assert_eq!(audit[0].action, "project_push");
    assert_eq!(audit[1].action, "project_delete");
    assert_eq!(audit[1].actor, "op");
}
