//! Tests for point handlers and the PointManager-driven filtering.

use crate::api::points::{list_points, PluginQuery};
use axum::extract::{Extension, Query, State};
use hmi_io_config::{AppConfig, PluginInstance, PointMapping};
use hmi_io_db::repo::Repo;
use hmi_io_point::manager::PointManager;
use std::sync::{Arc, Mutex};

fn mapping(id: &str) -> PointMapping {
    PointMapping {
        id: id.into(),
        address: "coil:0".into(),
        data_type: "bool".into(),
        byte_order: "big_endian".into(),
        scale: 1.0,
        offset: 0.0,
        var_type: "DI".into(),
    }
}

fn point_manager_with_two_instances() -> Arc<Mutex<PointManager>> {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        PluginInstance {
            name: "mb1".into(),
            wasm_file: "modbus.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: String::new(),
            redundancy_role: String::new(),
            priority: 0,
        },
        PluginInstance {
            name: "mb2".into(),
            wasm_file: "modbus.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: String::new(),
            redundancy_role: String::new(),
            priority: 0,
        },
    ];
    Arc::new(Mutex::new(PointManager::from_config(&cfg)))
}

#[tokio::test]
async fn list_points_returns_composite_hmi_id() {
    let repo = Arc::new(Repo::new(":memory:").await.unwrap());
    let pid = repo
        .insert_plugin("modbus_tcp", "modbus_tcp.wasm", "{}")
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
        "",
    )
    .await
    .unwrap();

    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![PluginInstance {
        name: "modbus_tcp".into(),
        wasm_file: "modbus_tcp.wasm".into(),
        config: serde_json::json!({}),
        points: vec![mapping("P1")],
        redundancy_group: String::new(),
        redundancy_role: String::new(),
        priority: 0,
    }];
    let pm = Arc::new(Mutex::new(PointManager::from_config(&cfg)));

    let res = list_points(
        State(repo),
        Extension(pm),
        Query(PluginQuery {
            plugin_id: None,
            include_backup: None,
        }),
    )
    .await
    .unwrap();
    let points = res.0;
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].plugin_name, "modbus_tcp");
    assert_eq!(points[0].hmi_id, "modbus_tcp:P1");
}

#[tokio::test]
async fn list_points_keeps_same_name_across_instances() {
    let repo = Arc::new(Repo::new(":memory:").await.unwrap());
    let p1 = repo
        .insert_plugin("mb1", "modbus.wasm", "{}")
        .await
        .unwrap();
    let p2 = repo
        .insert_plugin("mb2", "modbus.wasm", "{}")
        .await
        .unwrap();
    repo.insert_point(p1, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .await
        .unwrap();
    repo.insert_point(p2, "P1", "coil:1", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .await
        .unwrap();

    let res = list_points(
        State(repo),
        Extension(point_manager_with_two_instances()),
        Query(PluginQuery {
            plugin_id: None,
            include_backup: None,
        }),
    )
    .await
    .unwrap();
    let points = res.0;
    assert_eq!(points.len(), 2);
    let ids: Vec<&str> = points.iter().map(|p| p.hmi_id.as_str()).collect();
    assert!(ids.contains(&"mb1:P1"));
    assert!(ids.contains(&"mb2:P1"));
}

#[tokio::test]
async fn list_points_uses_group_logical_id_and_hides_backups() {
    let repo = Arc::new(Repo::new(":memory:").await.unwrap());
    let p1 = repo
        .insert_plugin_full("mb1", "mb.wasm", "{}", "mb-link", "primary", 0)
        .await
        .unwrap();
    let p2 = repo
        .insert_plugin_full("mb2", "mb.wasm", "{}", "mb-link", "backup", 1)
        .await
        .unwrap();
    repo.insert_point(p1, "P1", "a", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .await
        .unwrap();
    repo.insert_point(p2, "P1", "b", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .await
        .unwrap();

    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        PluginInstance {
            name: "mb1".into(),
            wasm_file: "mb.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "primary".into(),
            priority: 0,
        },
        PluginInstance {
            name: "mb2".into(),
            wasm_file: "mb.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 1,
        },
    ];
    let pm = Arc::new(Mutex::new(PointManager::from_config(&cfg)));

    let res = list_points(
        State(repo.clone()),
        Extension(pm.clone()),
        Query(PluginQuery {
            plugin_id: None,
            include_backup: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(res.0.len(), 1);
    assert_eq!(res.0[0].hmi_id, "mb-link:P1");

    let res = list_points(
        State(repo),
        Extension(pm),
        Query(PluginQuery {
            plugin_id: None,
            include_backup: Some(true),
        }),
    )
    .await
    .unwrap();
    assert_eq!(res.0.len(), 2);
}
