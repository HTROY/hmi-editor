//! Config snapshot application tests.

use crate::repo::{ConfigSnapshot, Repo, SnapshotAlarmRule, SnapshotPlugin, SnapshotPoint};

#[tokio::test]
async fn apply_config_snapshot_replaces_plugins_and_points() {
    let repo = Repo::new(":memory:").await.unwrap();
    let pid = repo.insert_plugin("old", "old.wasm", "{}").await.unwrap();
    repo.insert_point(pid, "P1", "a", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .await
        .unwrap();

    let snap = ConfigSnapshot {
        config_version: 7,
        scan_interval_ms: 1000,
        batch_interval_ms: 200,
        plugin_dir: "./plugins".into(),
        redundancy: serde_json::json!({"enabled": true}),
        alarm_retention_days: 90,
        soe_retention_days: 30,
        alarm_rules: vec![SnapshotAlarmRule {
            id: "ALM_1".into(),
            variable_id: "P2".into(),
            name: "test".into(),
            description: String::new(),
            severity: "warning".into(),
            group_name: "g".into(),
            condition: "high".into(),
            threshold: 10.0,
            enabled: true,
            hysteresis: 0.0,
            confirm_ms: 0,
        }],
        plugins: vec![SnapshotPlugin {
            name: "new".into(),
            wasm_file: "new.wasm".into(),
            config_json: "{}".into(),
            enabled: true,
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 1,
            points: vec![SnapshotPoint {
                variable_id: "P2".into(),
                address: "b".into(),
                data_type: "uint16".into(),
                byte_order: "big_endian".into(),
                scale: 1.0,
                offset_val: 0.0,
                var_type: "AI".into(),
                description: String::new(),
            }],
        }],
    };
    repo.apply_config_snapshot(&snap).await.unwrap();

    let plugins = repo.list_plugins().await.unwrap();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].name, "new");
    assert_eq!(plugins[0].redundancy_group, "mb-link");
    assert_eq!(plugins[0].redundancy_role, "backup");
    assert_eq!(plugins[0].priority, 1);
    let points = repo.list_points(None).await.unwrap();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].variable_id, "P2");
    assert_eq!(
        repo.get_config("config_version").await.as_deref(),
        Some("7")
    );
    assert_eq!(
        repo.get_config("scan_interval_ms").await.as_deref(),
        Some("1000")
    );
}
