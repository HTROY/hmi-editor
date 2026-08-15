//! Plugin CRUD tests.

use crate::repo::Repo;

#[tokio::test]
async fn plugin_row_round_trips_redundancy_fields() {
    let repo = Repo::new(":memory:").await.unwrap();
    let pid = repo
        .insert_plugin_full("mb1", "mb.wasm", "{}", "mb-link", "primary", 0)
        .await
        .unwrap();
    let p = repo.get_plugin(pid).await.unwrap().unwrap();
    assert_eq!(p.redundancy_group, "mb-link");
    assert_eq!(p.redundancy_role, "primary");
    assert_eq!(p.priority, 0);
    repo.update_plugin_full(pid, "mb1", "mb.wasm", "{}", "mb-link", "backup", 2, true)
        .await
        .unwrap();
    let p = repo.get_plugin(pid).await.unwrap().unwrap();
    assert_eq!(p.redundancy_role, "backup");
    assert_eq!(p.priority, 2);
}
