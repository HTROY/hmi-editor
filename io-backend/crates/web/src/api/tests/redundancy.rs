//! Tests for shared redundancy helpers.

use crate::api::build_config_snapshot;
use hmi_io_db::repo::Repo;

#[tokio::test]
async fn build_config_snapshot_includes_all_fields() {
    let repo = Repo::new(":memory:").await.unwrap();
    let pid = repo
        .insert_plugin("mb", "mb.wasm", "{\"host\":\"x\"}")
        .await
        .unwrap();
    repo.insert_point(
        pid,
        "P1",
        "coil:0",
        "bool",
        "big_endian",
        1.0,
        0.0,
        "DI",
        "d",
    )
    .await
    .unwrap();
    repo.set_config("config_version", "3").await.unwrap();
    repo.set_config("redundancy_config", r#"{"enabled":true}"#)
        .await
        .unwrap();

    let snap = build_config_snapshot(&repo).await;
    assert_eq!(snap.config_version, 3);
    assert_eq!(snap.plugins.len(), 1);
    assert_eq!(snap.plugins[0].name, "mb");
    assert_eq!(snap.plugins[0].points[0].variable_id, "P1");
    assert_eq!(snap.redundancy["enabled"], serde_json::Value::Bool(true));
}
