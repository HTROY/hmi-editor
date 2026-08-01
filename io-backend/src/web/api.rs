//! REST API handlers for plugin/point management

use crate::db::repo::{PluginRow, PointRow, Repo};
use crate::monitor::collector::MonitorCollector;
use crate::monitor::types::*;
use crate::point::manager::PointManager;
use crate::point::types::WsConfigChangeMessage;
use axum::{
    extract::{Extension, Multipart, Path, Query, State},
    http::StatusCode,
    response::Json,
};
use calamine::Reader;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

pub type AppState = Arc<Repo>;

#[derive(Deserialize)]
pub struct PluginQuery {
    pub plugin_id: Option<i64>,
}

pub async fn list_plugins(
    State(repo): State<AppState>,
) -> Result<Json<Vec<PluginRow>>, StatusCode> {
    repo.list_plugins().map(Json).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

pub async fn get_plugin(
    State(repo): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<PluginRow>, StatusCode> {
    match repo.get_plugin(id) {
        Ok(Some(p)) => Ok(Json(p)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(e) => {
            log::error!("{}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Deserialize)]
pub struct UpsertPlugin {
    pub name: String,
    pub wasm_file: String,
    #[serde(default)]
    pub config_json: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}
fn default_enabled() -> bool {
    true
}

pub async fn create_plugin(
    State(repo): State<AppState>,
    Json(p): Json<UpsertPlugin>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    repo.insert_plugin(&p.name, &p.wasm_file, &p.config_json)
        .map(|id| Json(serde_json::json!({"id": id})))
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

pub async fn update_plugin(
    State(repo): State<AppState>,
    Path(id): Path<i64>,
    Json(p): Json<UpsertPlugin>,
) -> Result<StatusCode, StatusCode> {
    repo.update_plugin(id, &p.name, &p.wasm_file, &p.config_json, p.enabled)
        .map(|_| StatusCode::OK)
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

pub async fn delete_plugin(State(repo): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    repo.delete_plugin(id)
        .map(|_| StatusCode::OK)
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn list_points(
    State(repo): State<AppState>,
    Extension(point_manager): Extension<Arc<Mutex<PointManager>>>,
    Query(q): Query<PluginQuery>,
) -> Result<Json<Vec<PointRow>>, StatusCode> {
    let all_points = repo.list_points(q.plugin_id).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let total_in_db = all_points.len();
    // 以 PointManager 为准：只返回实际在管理范围内的点位
    let pm = point_manager.lock().unwrap();
    let filtered: Vec<PointRow> = all_points
        .into_iter()
        .filter(|p| pm.has_point(&p.variable_id))
        .collect();
    if filtered.len() != total_in_db {
        log::warn!(
            "list_points: DB has {} points, PointManager manages {} ({} dropped)",
            total_in_db,
            pm.count(),
            total_in_db - filtered.len()
        );
    }
    Ok(Json(filtered))
}

#[derive(Deserialize)]
pub struct UpsertPoint {
    pub plugin_id: i64,
    pub variable_id: String,
    pub address: String,
    #[serde(default = "default_dtype")]
    pub data_type: String,
    #[serde(default = "default_border")]
    pub byte_order: String,
    #[serde(default)]
    pub scale: f64,
    #[serde(default)]
    pub offset_val: f64,
    #[serde(default = "default_vtype")]
    pub var_type: String,
    #[serde(default)]
    pub description: String,
}
fn default_dtype() -> String {
    "uint16".into()
}
fn default_border() -> String {
    "big_endian".into()
}
fn default_vtype() -> String {
    "AI".into()
}

fn send_config_change(
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

pub async fn create_point(
    State(repo): State<AppState>,
    Extension(broadcast_tx): Extension<broadcast::Sender<String>>,
    Json(p): Json<UpsertPoint>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let plugin_id = p.plugin_id;
    let var_id = p.variable_id.clone();
    let result = repo
        .insert_point(
            p.plugin_id,
            &p.variable_id,
            &p.address,
            &p.data_type,
            &p.byte_order,
            p.scale,
            p.offset_val,
            &p.var_type,
            &p.description,
        )
        .map(|id| Json(serde_json::json!({"id": id})))
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    send_config_change(&broadcast_tx, "create", &var_id, plugin_id);
    Ok(result)
}

pub async fn update_point(
    State(repo): State<AppState>,
    Extension(broadcast_tx): Extension<broadcast::Sender<String>>,
    Path(id): Path<i64>,
    Json(p): Json<UpsertPoint>,
) -> Result<StatusCode, StatusCode> {
    let plugin_id = p.plugin_id;
    let var_id = p.variable_id.clone();
    repo.update_point(
        id,
        &p.variable_id,
        &p.address,
        &p.data_type,
        &p.byte_order,
        p.scale,
        p.offset_val,
        &p.var_type,
        &p.description,
    )
    .map(|_| StatusCode::OK)
    .map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    send_config_change(&broadcast_tx, "update", &var_id, plugin_id);
    Ok(StatusCode::OK)
}

pub async fn delete_point(
    State(repo): State<AppState>,
    Extension(broadcast_tx): Extension<broadcast::Sender<String>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, StatusCode> {
    // Get point info before deletion for the notification
    let point_info = repo.get_point(id).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let (plugin_id, var_id) = match &point_info {
        Some(p) => (p.plugin_id, p.variable_id.clone()),
        None => (0, String::new()),
    };
    repo.delete_point(id).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    if !var_id.is_empty() {
        send_config_change(&broadcast_tx, "delete", &var_id, plugin_id);
    }
    Ok(StatusCode::OK)
}

pub async fn import_excel(
    State(repo): State<AppState>,
    Path(plugin_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, StatusCode> {
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            let data = field.bytes().await.map_err(|_| StatusCode::BAD_REQUEST)?;
            let cursor = std::io::Cursor::new(data);
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor).map_err(|e| {
                log::error!("Excel: {}", e);
                StatusCode::BAD_REQUEST
            })?;
            if let Some(Ok(range)) = workbook.worksheet_range_at(0) {
                let rows = range.rows();
                let mut imported: usize = 0;
                for (i, row) in rows.enumerate() {
                    if i == 0 {
                        continue;
                    }
                    if row.len() < 7 {
                        continue;
                    }
                    let var_id = row[0].to_string().trim().to_string();
                    if var_id.is_empty() {
                        continue;
                    }
                    let addr = row[1].to_string().trim().to_string();
                    let dtype = if row.len() > 2 {
                        row[2].to_string().trim().to_string()
                    } else {
                        "uint16".into()
                    };
                    let border = if row.len() > 3 {
                        row[3].to_string().trim().to_string()
                    } else {
                        "big_endian".into()
                    };
                    let scale: f64 = if row.len() > 4 {
                        row[4].to_string().trim().parse().unwrap_or(1.0)
                    } else {
                        1.0
                    };
                    let off: f64 = if row.len() > 5 {
                        row[5].to_string().trim().parse().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    let vtype = if row.len() > 6 {
                        row[6].to_string().trim().to_string()
                    } else {
                        "AI".into()
                    };
                    let desc = if row.len() > 7 {
                        row[7].to_string().trim().to_string()
                    } else {
                        String::new()
                    };
                    if let Err(e) = repo.insert_point(
                        plugin_id, &var_id, &addr, &dtype, &border, scale, off, &vtype, &desc,
                    ) {
                        log::error!("import row {}: {}", i, e);
                    } else {
                        imported += 1;
                    }
                }
                return Ok(Json(serde_json::json!({"imported": imported})));
            }
        }
    }
    Err(StatusCode::BAD_REQUEST)
}

pub async fn export_excel(
    State(repo): State<AppState>,
    Path(plugin_id): Path<i64>,
) -> Result<(StatusCode, [(String, String); 2], Vec<u8>), StatusCode> {
    let points = repo.list_points(Some(plugin_id)).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let mut wb = rust_xlsxwriter::Workbook::new();
    let sheet = wb.add_worksheet();
    let headers: [&str; 8] = [
        "variable_id",
        "address",
        "data_type",
        "byte_order",
        "scale",
        "offset",
        "var_type",
        "description",
    ];
    for (c, h) in headers.iter().enumerate() {
        let _ = sheet.write_string(0, c as u16, *h);
    }
    for (r, pt) in points.iter().enumerate() {
        let row = (r + 1) as u32;
        let _ = sheet.write_string(row, 0, pt.variable_id.as_str());
        let _ = sheet.write_string(row, 1, pt.address.as_str());
        let _ = sheet.write_string(row, 2, pt.data_type.as_str());
        let _ = sheet.write_string(row, 3, pt.byte_order.as_str());
        let _ = sheet.write_number(row, 4, pt.scale);
        let _ = sheet.write_number(row, 5, pt.offset_val);
        let _ = sheet.write_string(row, 6, pt.var_type.as_str());
        let _ = sheet.write_string(row, 7, pt.description.as_str());
    }
    let buf = wb.save_to_buffer().map_err(|e| {
        log::error!("xlsx: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    Ok((
        StatusCode::OK,
        [
            (
                "Content-Type".into(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
            ),
            (
                "Content-Disposition".into(),
                format!("attachment; filename=points_{}.xlsx", plugin_id),
            ),
        ],
        buf,
    ))
}

#[derive(Serialize)]
pub struct ConfigExport {
    pub scan_interval_ms: u64,
    pub plugins: Vec<PluginWithPointsExport>,
}
#[derive(Serialize)]
pub struct PluginWithPointsExport {
    pub name: String,
    pub wasm_file: String,
    pub config_json: serde_json::Value,
    pub enabled: bool,
    pub points: Vec<PointExport>,
}
#[derive(Serialize)]
pub struct PointExport {
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}

pub async fn export_config(State(repo): State<AppState>) -> Result<Json<ConfigExport>, StatusCode> {
    let pws = repo.list_plugins_with_points().map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let scan_ms: u64 = repo
        .get_config("scan_interval_ms")
        .unwrap_or_else(|| "500".into())
        .parse()
        .unwrap_or(500);
    let plugins = pws
        .into_iter()
        .filter(|p| p.plugin.enabled)
        .map(|pw| PluginWithPointsExport {
            name: pw.plugin.name,
            wasm_file: pw.plugin.wasm_file,
            config_json: serde_json::from_str(&pw.plugin.config_json)
                .unwrap_or(serde_json::json!({})),
            enabled: pw.plugin.enabled,
            points: pw
                .points
                .into_iter()
                .map(|p| PointExport {
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
    Ok(Json(ConfigExport {
        scan_interval_ms: scan_ms,
        plugins,
    }))
}

// ============================================================
// Monitor API handlers
// ============================================================

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
) -> Result<Json<PluginStatus>, StatusCode> {
    monitor
        .get_plugin_status(&name)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
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
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let limit = q.limit.unwrap_or(300).min(MAX_HISTORY_LIMIT);
    Json(monitor.get_history(limit, scan_interval_ms))
}

const MAX_HISTORY_LIMIT: usize = 900;

// ============================================================
