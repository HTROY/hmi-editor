//! Monitor API handlers (live status, live points, packet logs, history).

use super::AppState;
use axum::{
    extract::{Extension, Path, Query, State},
    response::Json,
};
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_monitor::types::*;
use serde::Deserialize;
use std::sync::Arc;

/// GET /api/monitor/overview
pub async fn monitor_overview(
    Extension(monitor): Extension<Arc<MonitorCollector>>,
) -> Json<MonitorSnapshot> {
    Json(monitor.get_snapshot())
}

/// GET /api/monitor/plugins/{name}/status
pub async fn monitor_plugin_status(
    Extension(monitor): Extension<Arc<MonitorCollector>>,
    Path(name): Path<String>,
) -> Result<Json<PluginStatus>, axum::http::StatusCode> {
    monitor
        .get_plugin_status(&name)
        .map(Json)
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

/// GET /api/monitor/plugins/{name}/points
pub async fn monitor_plugin_points(
    Extension(monitor): Extension<Arc<MonitorCollector>>,
    Path(name): Path<String>,
) -> Json<Vec<LivePointInfo>> {
    Json(monitor.get_live_points(&name))
}

/// GET /api/monitor/plugins/{name}/packets?limit=100
#[derive(Deserialize)]
pub struct PacketQuery {
    pub limit: Option<usize>,
}

pub async fn monitor_plugin_packets(
    Extension(monitor): Extension<Arc<MonitorCollector>>,
    Path(name): Path<String>,
    Query(q): Query<PacketQuery>,
) -> Json<Vec<PacketLogEntry>> {
    let limit = q.limit.unwrap_or(100).min(1000);
    Json(monitor.get_packets(&name, limit))
}

/// GET /api/monitor/history?limit=300
#[derive(Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<usize>,
}

pub async fn monitor_history(
    Extension(monitor): Extension<Arc<MonitorCollector>>,
    State(repo): State<AppState>,
    Query(q): Query<HistoryQuery>,
) -> Json<MonitorHistory> {
    let scan_interval_ms: u64 = repo
        .get_config("scan_interval_ms")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let limit = q.limit.unwrap_or(300).min(MAX_HISTORY_LIMIT);
    Json(monitor.get_history(limit, scan_interval_ms))
}

const MAX_HISTORY_LIMIT: usize = 900;
