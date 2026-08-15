//! Redundancy API handlers (heartbeat / sync / claim / config push / status).

use super::{api_error, bump_version_and_push, AppState};
use axum::{
    extract::{Extension, Json, State},
    http::StatusCode,
};
use hmi_io_alarm::engine::AlarmEngine;
use hmi_io_alarm::types::AlarmRule;
use hmi_io_config::RedundancyConfig;
use hmi_io_db::repo::ConfigSnapshot;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::redundancy::{
    ClaimBody, ClaimResult, ConfigPushBody, HeartbeatInfo, RedundancyEngine, RedundancyStatus,
    SyncBody,
};
use std::sync::Arc;

pub async fn get_redundancy_config(
    State(repo): State<AppState>,
) -> Result<Json<RedundancyConfig>, StatusCode> {
    let cfg: RedundancyConfig = repo
        .get_config("redundancy_config")
        .await
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(Json(cfg))
}

pub async fn update_redundancy_config(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(cfg): Json<RedundancyConfig>,
) -> Result<StatusCode, StatusCode> {
    if cfg.enabled {
        if cfg.node_id.is_empty() || cfg.peer_url.is_empty() {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let json = serde_json::to_string(&cfg).map_err(|e| api_error(e.into()))?;
    repo.set_config("redundancy_config", &json)
        .await
        .map_err(api_error)?;
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(StatusCode::OK)
}

pub async fn redundancy_heartbeat(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
) -> Json<HeartbeatInfo> {
    engine.record_peer_seen(0);
    Json(engine.heartbeat_info())
}

pub async fn redundancy_sync(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<SyncBody>,
) -> Result<StatusCode, StatusCode> {
    engine
        .handle_sync(&body)
        .map(|_| StatusCode::OK)
        .map_err(|e| {
            log::warn!("redundancy sync rejected: {}", e);
            StatusCode::CONFLICT
        })
}

pub async fn redundancy_snapshot(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
) -> Json<SyncBody> {
    Json(engine.snapshot_for_peer())
}

pub async fn apply_config_push(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Json(body): Json<ConfigPushBody>,
) -> Result<StatusCode, StatusCode> {
    let snap: ConfigSnapshot = serde_json::from_value(body.config).map_err(|e| {
        log::error!("bad config push: {}", e);
        StatusCode::BAD_REQUEST
    })?;
    let snap_version = snap.config_version;
    let local: u64 = repo
        .get_config("config_version")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if snap.config_version < local {
        return Ok(StatusCode::OK); // 旧版本，忽略
    }
    repo.apply_config_snapshot(&snap)
        .await
        .map_err(|e| api_error(anyhow::anyhow!("apply config snapshot failed: {}", e)))?;
    // Reload alarm rules into the in-memory engine (diff-based recovery).
    let rules: Vec<AlarmRule> = repo
        .list_alarm_rules()
        .await
        .map_err(|e| {
            api_error(anyhow::anyhow!(
                "load alarm rules after config push failed: {}",
                e
            ))
        })?
        .into_iter()
        .map(AlarmRule::from)
        .collect();
    alarm_engine.replace_rules(rules);
    engine.set_config_version(snap_version);
    engine
        .state()
        .record_event("config_synced", format!("applied config v{}", snap_version));
    Ok(StatusCode::OK)
}

pub async fn redundancy_claim(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<ClaimBody>,
) -> Json<ClaimResult> {
    Json(engine.handle_claim(&body))
}

pub async fn redundancy_status(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
) -> Json<RedundancyStatus> {
    Json(engine.state().get_status())
}

pub async fn redundancy_instance_groups(
    Extension(registry): Extension<Arc<PluginRegistry>>,
) -> Json<Vec<hmi_io_plugin::registry::InstanceGroupStatus>> {
    Json(registry.instance_groups_status())
}
