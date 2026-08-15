//! REST API handlers, split per resource domain so that adding a resource
//! only touches one small file. `server.rs` stays pure route assembly.
//!
//! Shared cross-domain helpers (error mapping, config-version bump & push,
//! config snapshot building, WS config-change broadcast) live here.

pub mod alarms;
pub mod config;
pub mod excel;
pub mod monitor;
pub mod plugins;
pub mod points;
pub mod redundancy;

use hmi_io_db::repo::{ConfigSnapshot, Repo, SnapshotAlarmRule, SnapshotPlugin, SnapshotPoint};
use hmi_io_point::redundancy::RedundancyEngine;
use hmi_io_point::types::WsConfigChangeMessage;
use std::sync::Arc;
use tokio::sync::broadcast;

pub type AppState = Arc<Repo>;

/// Log a repository error and map it to a 500 response.
pub fn api_error(e: anyhow::Error) -> axum::http::StatusCode {
    log::error!("{}", e);
    axum::http::StatusCode::INTERNAL_SERVER_ERROR
}

/// Broadcast a WS `config_change` message (create/update/delete of points).
pub fn send_config_change(
    broadcast_tx: &broadcast::Sender<String>,
    action: &str,
    variable_id: &str,
    plugin_id: i64,
) {
    let msg = WsConfigChangeMessage::new(action, variable_id, plugin_id);
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = broadcast_tx.send(json);
        log::debug!("Broadcast config_change: {} {}", action, variable_id);
    }
}

/// 本地配置变更后：递增版本并向对端推送（仅 Active 节点）。
/// Repo 方法异步化（tokio-rusqlite 专用 DB 线程），不占异步 worker。
pub(crate) async fn bump_version_and_push(repo: Arc<Repo>, engine: Arc<RedundancyEngine>) {
    if !engine.is_active() {
        return;
    }
    let v = match repo.get_config("config_version").await {
        Some(s) => s.parse::<u64>().unwrap_or(0),
        None => 0,
    } + 1;
    let _ = repo.set_config("config_version", &v.to_string()).await;
    engine.set_config_version(v);
    let snap = build_config_snapshot(&repo).await;
    let json = serde_json::to_value(&snap).unwrap_or(serde_json::json!({}));
    engine.push_config(json).await;
}

pub(crate) async fn build_config_snapshot(repo: &Repo) -> ConfigSnapshot {
    let scan_ms: u64 = repo
        .get_config("scan_interval_ms")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let batch_ms: u64 = repo
        .get_config("batch_interval_ms")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);
    let plugin_dir = repo
        .get_config("plugin_dir")
        .await
        .unwrap_or_else(|| "./plugins".into());
    let version = repo
        .get_config("config_version")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let redundancy = repo
        .get_config("redundancy_config")
        .await
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    let alarm_retention_days: u32 = repo
        .get_config("alarm_retention_days")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(90);
    let soe_retention_days: u32 = repo
        .get_config("soe_retention_days")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let alarm_rules: Vec<SnapshotAlarmRule> = repo
        .list_alarm_rules()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|r| SnapshotAlarmRule {
            id: r.id,
            variable_id: r.variable_id,
            name: r.name,
            description: r.description,
            severity: r.severity,
            group_name: r.group_name,
            condition: r.condition,
            threshold: r.threshold,
            enabled: r.enabled,
            hysteresis: r.hysteresis,
            confirm_ms: r.confirm_ms,
        })
        .collect();
    let plugins = repo
        .list_plugins_with_points()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|pw| SnapshotPlugin {
            name: pw.plugin.name,
            wasm_file: pw.plugin.wasm_file,
            config_json: pw.plugin.config_json,
            enabled: pw.plugin.enabled,
            redundancy_group: pw.plugin.redundancy_group.clone(),
            redundancy_role: pw.plugin.redundancy_role.clone(),
            priority: pw.plugin.priority,
            points: pw
                .points
                .into_iter()
                .map(|p| SnapshotPoint {
                    variable_id: p.variable_id,
                    address: p.address,
                    data_type: p.data_type,
                    byte_order: p.byte_order,
                    scale: p.scale,
                    offset_val: p.offset_val,
                    var_type: p.var_type,
                    description: p.description,
                })
                .collect(),
        })
        .collect();
    ConfigSnapshot {
        config_version: version,
        scan_interval_ms: scan_ms,
        batch_interval_ms: batch_ms,
        plugin_dir,
        redundancy,
        alarm_retention_days,
        soe_retention_days,
        alarm_rules,
        plugins,
    }
}

#[cfg(test)]
mod tests;
