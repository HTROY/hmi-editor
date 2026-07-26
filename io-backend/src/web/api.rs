//! REST API handlers for plugin/point management

use std::sync::Arc;
use axum::{
    extract::{Path, Query, State, Extension, Multipart},
    response::Json,
    http::StatusCode,
};
use calamine::Reader;
use serde::{Deserialize, Serialize};
use crate::db::repo::{Repo, PluginRow, PointRow};
use crate::monitor::collector::MonitorCollector;
use crate::monitor::types::*;

pub type AppState = Arc<Repo>;

#[derive(Deserialize)]
pub struct PluginQuery { pub plugin_id: Option<i64> }

pub async fn list_plugins(State(repo): State<AppState>) -> Result<Json<Vec<PluginRow>>, StatusCode> {
    repo.list_plugins().map(Json).map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })
}

pub async fn get_plugin(State(repo): State<AppState>, Path(id): Path<i64>) -> Result<Json<PluginRow>, StatusCode> {
    match repo.get_plugin(id) {
        Ok(Some(p)) => Ok(Json(p)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(e) => { log::error!("{}", e); Err(StatusCode::INTERNAL_SERVER_ERROR) }
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
fn default_enabled() -> bool { true }

pub async fn create_plugin(State(repo): State<AppState>, Json(p): Json<UpsertPlugin>) -> Result<Json<serde_json::Value>, StatusCode> {
    repo.insert_plugin(&p.name, &p.wasm_file, &p.config_json)
        .map(|id| Json(serde_json::json!({"id": id})))
        .map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })
}

pub async fn update_plugin(State(repo): State<AppState>, Path(id): Path<i64>, Json(p): Json<UpsertPlugin>) -> Result<StatusCode, StatusCode> {
    repo.update_plugin(id, &p.name, &p.wasm_file, &p.config_json, p.enabled)
        .map(|_| StatusCode::OK)
        .map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })
}

pub async fn delete_plugin(State(repo): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    repo.delete_plugin(id).map(|_| StatusCode::OK).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn list_points(State(repo): State<AppState>, Query(q): Query<PluginQuery>) -> Result<Json<Vec<PointRow>>, StatusCode> {
    repo.list_points(q.plugin_id).map(Json).map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })
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
fn default_dtype() -> String { "uint16".into() }
fn default_border() -> String { "big_endian".into() }
fn default_vtype() -> String { "AI".into() }

pub async fn create_point(State(repo): State<AppState>, Json(p): Json<UpsertPoint>) -> Result<Json<serde_json::Value>, StatusCode> {
    repo.insert_point(p.plugin_id, &p.variable_id, &p.address, &p.data_type, &p.byte_order, p.scale, p.offset_val, &p.var_type, &p.description)
        .map(|id| Json(serde_json::json!({"id": id})))
        .map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })
}

pub async fn update_point(State(repo): State<AppState>, Path(id): Path<i64>, Json(p): Json<UpsertPoint>) -> Result<StatusCode, StatusCode> {
    repo.update_point(id, &p.variable_id, &p.address, &p.data_type, &p.byte_order, p.scale, p.offset_val, &p.var_type, &p.description)
        .map(|_| StatusCode::OK)
        .map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })
}

pub async fn delete_point(State(repo): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    repo.delete_point(id).map(|_| StatusCode::OK).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
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
            let mut workbook = calamine::open_workbook_auto_from_rs(cursor)
                .map_err(|e| { log::error!("Excel: {}", e); StatusCode::BAD_REQUEST })?;
            if let Some(Ok(range)) = workbook.worksheet_range_at(0) {
                let rows = range.rows();
                let mut imported: usize = 0;
                for (i, row) in rows.enumerate() {
                    if i == 0 { continue; }
                    if row.len() < 7 { continue; }
                    let var_id = row[0].to_string();
                    let addr = row[1].to_string();
                    if var_id.is_empty() || addr.is_empty() { continue; }
                    let dtype = row.get(2).map(|c| c.to_string()).unwrap_or_else(|| "uint16".into());
                    let border = row.get(3).map(|c| c.to_string()).unwrap_or_else(|| "big_endian".into());
                    let scale = row.get(4).and_then(|c| c.to_string().parse().ok()).unwrap_or(1.0);
                    let off = row.get(5).and_then(|c| c.to_string().parse().ok()).unwrap_or(0.0);
                    let vtype = row.get(6).map(|c| c.to_string()).unwrap_or_else(|| "AI".into());
                    let desc = row.get(7).map(|c| c.to_string()).unwrap_or_default();
                    if let Err(e) = repo.insert_point(plugin_id, &var_id, &addr, &dtype, &border, scale, off, &vtype, &desc) {
                        log::error!("import row {}: {}", i, e);
                    } else { imported += 1; }
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
    let points = repo.list_points(Some(plugin_id)).map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })?;
    let mut wb = rust_xlsxwriter::Workbook::new();
    let sheet = wb.add_worksheet();
    let headers: [&str; 8] = ["variable_id","address","data_type","byte_order","scale","offset","var_type","description"];
    for (c, h) in headers.iter().enumerate() {
        let _ = sheet.write_string(0, c as u16, *h);
    }
    for (r, pt) in points.iter().enumerate() {
        let row = (r+1) as u32;
        let _ = sheet.write_string(row, 0, pt.variable_id.as_str());
        let _ = sheet.write_string(row, 1, pt.address.as_str());
        let _ = sheet.write_string(row, 2, pt.data_type.as_str());
        let _ = sheet.write_string(row, 3, pt.byte_order.as_str());
        let _ = sheet.write_number(row, 4, pt.scale);
        let _ = sheet.write_number(row, 5, pt.offset_val);
        let _ = sheet.write_string(row, 6, pt.var_type.as_str());
        let _ = sheet.write_string(row, 7, pt.description.as_str());
    }
    let buf = wb.save_to_buffer().map_err(|e| { log::error!("xlsx: {}", e); StatusCode::INTERNAL_SERVER_ERROR })?;
    Ok((StatusCode::OK, [
        ("Content-Type".into(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into()),
        ("Content-Disposition".into(), format!("attachment; filename=points_{}.xlsx", plugin_id)),
    ], buf))
}

#[derive(Serialize)]
pub struct ConfigExport {
    pub scan_interval_ms: u64,
    pub plugins: Vec<PluginWithPointsExport>,
}
#[derive(Serialize)]
pub struct PluginWithPointsExport {
    pub name: String, pub wasm_file: String, pub config_json: serde_json::Value, pub enabled: bool, pub points: Vec<PointExport>,
}
#[derive(Serialize)]
pub struct PointExport {
    pub variable_id: String, pub address: String, pub data_type: String, pub byte_order: String,
    pub scale: f64, pub offset_val: f64, pub var_type: String, pub description: String,
}

pub async fn export_config(State(repo): State<AppState>) -> Result<Json<ConfigExport>, StatusCode> {
    let pws = repo.list_plugins_with_points().map_err(|e| { log::error!("{}", e); StatusCode::INTERNAL_SERVER_ERROR })?;
    let scan_ms: u64 = repo.get_config("scan_interval_ms").unwrap_or_else(|| "500".into()).parse().unwrap_or(500);
    let plugins = pws.into_iter().filter(|p| p.plugin.enabled).map(|pw| PluginWithPointsExport {
        name: pw.plugin.name, wasm_file: pw.plugin.wasm_file,
        config_json: serde_json::from_str(&pw.plugin.config_json).unwrap_or(serde_json::json!({})),
        enabled: pw.plugin.enabled,
        points: pw.points.into_iter().map(|p| PointExport {
            variable_id: p.variable_id, address: p.address, data_type: p.data_type, byte_order: p.byte_order,
            scale: p.scale, offset_val: p.offset_val, var_type: p.var_type, description: p.description,
        }).collect(),
    }).collect();
    Ok(Json(ConfigExport { scan_interval_ms: scan_ms, plugins }))
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
    monitor.get_plugin_status(&name)
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
pub struct PacketQuery { pub limit: Option<usize> }

pub async fn monitor_plugin_packets(
    Extension(monitor): Extension<Arc<MonitorCollector>>,
    Path(name): Path<String>,
    Query(q): Query<PacketQuery>,
) -> Json<Vec<PacketLogEntry>> {
    let limit = q.limit.unwrap_or(100).min(1000);
    Json(monitor.get_packets(&name, limit))
}