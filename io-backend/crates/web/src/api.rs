//! REST API handlers for plugin/point management

use hmi_io_config::RedundancyConfig;
use hmi_io_alarm::engine::AlarmEngine;
use hmi_io_alarm::types::{AlarmOccurrence, AlarmRule, AlarmStreamEvent};
use hmi_io_db::repo::{
    AlarmRuleRow, ConfigSnapshot, PluginRow, PointRow, Repo, SnapshotAlarmRule, SnapshotPoint,
    SnapshotPlugin,
};
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_monitor::types::*;
use hmi_io_point::manager::PointManager;
use hmi_io_point::redundancy::{
    ClaimBody, ClaimResult, ConfigPushBody, HeartbeatInfo, RedundancyEngine, RedundancyStatus,
    SyncBody,
};
use hmi_io_point::types::WsConfigChangeMessage;
use hmi_io_point::point_key;
use axum::{
    extract::{Extension, Multipart, Path, Query, State},
    http::StatusCode,
    response::Json,
};
use calamine::Reader;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use std::sync::atomic::{AtomicU64, Ordering};

pub type AppState = Arc<Repo>;

#[derive(Deserialize)]
pub struct PluginQuery {
    pub plugin_id: Option<i64>,
    pub include_backup: Option<bool>,
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
    #[serde(default)]
    pub redundancy_group: String,
    #[serde(default)]
    pub redundancy_role: String,
    #[serde(default)]
    pub priority: u32,
}
fn default_enabled() -> bool {
    true
}

fn validate_group_edit(
    repo: &Repo,
    candidate: &UpsertPlugin,
    edit_id: Option<i64>,
) -> Result<(), StatusCode> {
    let mut plugins = repo.list_plugins().map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    if let Some(id) = edit_id {
        plugins.retain(|p| p.id != id);
    }
    plugins.push(PluginRow {
        id: edit_id.unwrap_or(0),
        name: candidate.name.clone(),
        wasm_file: candidate.wasm_file.clone(),
        config_json: candidate.config_json.clone(),
        enabled: candidate.enabled,
        redundancy_group: candidate.redundancy_group.clone(),
        redundancy_role: candidate.redundancy_role.clone(),
        priority: candidate.priority,
    });
    let instances: Vec<hmi_io_config::PluginInstance> = plugins
        .into_iter()
        .map(|p| {
            let points = repo
                .list_points(Some(p.id))
                .unwrap_or_default()
                .into_iter()
                .map(|pt| hmi_io_config::PointMapping {
                    id: pt.variable_id,
                    address: pt.address,
                    data_type: pt.data_type,
                    byte_order: pt.byte_order,
                    scale: pt.scale,
                    offset: pt.offset_val,
                    var_type: pt.var_type,
                })
                .collect();
            hmi_io_config::PluginInstance {
                name: p.name,
                wasm_file: p.wasm_file,
                config: serde_json::from_str(&p.config_json).unwrap_or(serde_json::json!({})),
                points,
                redundancy_group: p.redundancy_group,
                redundancy_role: p.redundancy_role,
                priority: p.priority,
            }
        })
        .collect();
    let mut cfg = hmi_io_config::AppConfig::default_config();
    cfg.plugins.instances = instances;
    cfg.validate().map_err(|e| {
        log::warn!("group validation failed: {}", e);
        StatusCode::BAD_REQUEST
    })
}

pub async fn create_plugin(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(p): Json<UpsertPlugin>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    validate_group_edit(&repo, &p, None)?;
    let id = repo
        .insert_plugin_full(
            &p.name,
            &p.wasm_file,
            &p.config_json,
            &p.redundancy_group,
            &p.redundancy_role,
            p.priority,
        )
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    bump_version_and_push(&repo, &engine).await;
    Ok(Json(serde_json::json!({"id": id})))
}

pub async fn update_plugin(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<i64>,
    Json(p): Json<UpsertPlugin>,
) -> Result<StatusCode, StatusCode> {
    validate_group_edit(&repo, &p, Some(id))?;
    repo.update_plugin_full(
        id,
        &p.name,
        &p.wasm_file,
        &p.config_json,
        &p.redundancy_group,
        &p.redundancy_role,
        p.priority,
        p.enabled,
    )
        .map(|_| StatusCode::OK)
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    bump_version_and_push(&repo, &engine).await;
    Ok(StatusCode::OK)
}

pub async fn delete_plugin(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<i64>,
) -> StatusCode {
    match repo.delete_plugin(id) {
        Ok(()) => {
            bump_version_and_push(&repo, &engine).await;
            StatusCode::OK
        }
        Err(e) => {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(Serialize)]
pub struct PointView {
    pub id: i64,
    pub plugin_id: i64,
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
    pub plugin_name: String,
    pub hmi_id: String,
    pub redundancy_group: String,
    pub plugin_role: String,
}

impl From<PointRow> for PointView {
    fn from(row: PointRow) -> Self {
        let hmi_id = hmi_id_for_point(&row);
        Self {
            id: row.id,
            plugin_id: row.plugin_id,
            variable_id: row.variable_id,
            address: row.address,
            data_type: row.data_type,
            byte_order: row.byte_order,
            scale: row.scale,
            offset_val: row.offset_val,
            var_type: row.var_type,
            description: row.description,
            plugin_name: row.plugin_name,
            hmi_id,
            redundancy_group: row.redundancy_group,
            plugin_role: row.redundancy_role,
        }
    }
}

fn hmi_id_for_point(p: &PointRow) -> String {
    if p.redundancy_group.is_empty() {
        point_key(&p.plugin_name, &p.variable_id)
    } else {
        point_key(&p.redundancy_group, &p.variable_id)
    }
}

pub async fn list_points(
    State(repo): State<AppState>,
    Extension(point_manager): Extension<Arc<Mutex<PointManager>>>,
    Query(q): Query<PluginQuery>,
) -> Result<Json<Vec<PointView>>, StatusCode> {
    let all_points = repo.list_points(q.plugin_id).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let total_in_db = all_points.len();
    let include_backup = q.include_backup.unwrap_or(false);
    // 以 PointManager 为准：只返回实际在管理范围内的点位
    let pm = point_manager.lock().unwrap();
    let filtered: Vec<PointView> = all_points
        .into_iter()
        .filter(|p| pm.has_point(&hmi_id_for_point(p)))
        .filter(|p| include_backup || p.redundancy_role != "backup")
        .map(PointView::from)
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
    Extension(engine): Extension<Arc<RedundancyEngine>>,
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
    bump_version_and_push(&repo, &engine).await;
    Ok(result)
}

pub async fn update_point(
    State(repo): State<AppState>,
    Extension(broadcast_tx): Extension<broadcast::Sender<String>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
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
    bump_version_and_push(&repo, &engine).await;
    Ok(StatusCode::OK)
}

pub async fn delete_point(
    State(repo): State<AppState>,
    Extension(broadcast_tx): Extension<broadcast::Sender<String>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
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
    bump_version_and_push(&repo, &engine).await;
    Ok(StatusCode::OK)
}

pub async fn import_excel(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
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
                bump_version_and_push(&repo, &engine).await;
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
// Redundancy API
// ============================================================

fn build_config_snapshot(repo: &Repo) -> ConfigSnapshot {
    let scan_ms: u64 = repo
        .get_config("scan_interval_ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let batch_ms: u64 = repo
        .get_config("batch_interval_ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);
    let plugin_dir = repo
        .get_config("plugin_dir")
        .unwrap_or_else(|| "./plugins".into());
    let version = repo
        .get_config("config_version")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let redundancy = repo
        .get_config("redundancy_config")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    let alarm_retention_days: u32 = repo
        .get_config("alarm_retention_days")
        .and_then(|v| v.parse().ok())
        .unwrap_or(90);
    let soe_retention_days: u32 = repo
        .get_config("soe_retention_days")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let alarm_rules: Vec<SnapshotAlarmRule> = repo
        .list_alarm_rules()
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

/// 本地配置变更后：递增版本并向对端推送（仅 Active 节点）。
async fn bump_version_and_push(repo: &Repo, engine: &RedundancyEngine) {
    if !engine.is_active() {
        return;
    }
    let v = repo
        .get_config("config_version")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        + 1;
    let _ = repo.set_config("config_version", &v.to_string());
    engine.set_config_version(v);
    let snap = build_config_snapshot(repo);
    let json = serde_json::to_value(&snap).unwrap_or(serde_json::json!({}));
    engine.push_config(json).await;
}

pub async fn get_redundancy_config(
    State(repo): State<AppState>,
) -> Result<Json<RedundancyConfig>, StatusCode> {
    let cfg: RedundancyConfig = repo
        .get_config("redundancy_config")
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
    let json = serde_json::to_string(&cfg).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    repo.set_config("redundancy_config", &json)
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    bump_version_and_push(&repo, &engine).await;
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
    engine.handle_sync(&body).map(|_| StatusCode::OK).map_err(|e| {
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
    let local: u64 = repo
        .get_config("config_version")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if snap.config_version < local {
        return Ok(StatusCode::OK); // 旧版本，忽略
    }
    repo.apply_config_snapshot(&snap).map_err(|e| {
        log::error!("apply config snapshot failed: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    // Reload alarm rules into the in-memory engine (diff-based recovery).
    let rules: Vec<AlarmRule> = repo
        .list_alarm_rules()
        .map_err(|e| {
            log::error!("load alarm rules after config push failed: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .into_iter()
        .map(AlarmRule::from)
        .collect();
    alarm_engine.replace_rules(rules);
    engine.set_config_version(snap.config_version);
    engine
        .state()
        .record_event("config_synced", format!("applied config v{}", snap.config_version));
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
    Extension(registry): Extension<Arc<hmi_io_plugin::registry::PluginRegistry>>,
) -> Json<Vec<hmi_io_plugin::registry::InstanceGroupStatus>> {
    Json(registry.instance_groups_status())
}

// ============================================================
// Alarm & SOE API
// ============================================================

pub async fn list_alarm_rules(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
) -> Json<Vec<AlarmRule>> {
    Json(alarm_engine.rules())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRuleUpsert {
    #[serde(default)]
    pub id: Option<String>,
    pub variable_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub severity: hmi_io_alarm::types::Severity,
    #[serde(default)]
    pub group: String,
    pub condition: hmi_io_alarm::types::Condition,
    pub threshold: f64,
    #[serde(default = "default_rule_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub hysteresis: f64,
    #[serde(default)]
    pub confirm_ms: u64,
}

fn default_rule_enabled() -> bool {
    true
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static RULE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Build a rule from the upsert body. `path_id` (PUT /{id}) wins over the body
/// id; when both are absent, an id is generated server-side.
fn rule_from_upsert(body: AlarmRuleUpsert, path_id: Option<String>) -> AlarmRule {
    let id = match path_id.or(body.id) {
        Some(id) if !id.trim().is_empty() => id,
        _ => format!(
            "rule_{}_{}",
            now_ms(),
            RULE_SEQ.fetch_add(1, Ordering::Relaxed)
        ),
    };
    AlarmRule {
        id,
        variable_id: body.variable_id,
        name: body.name,
        description: body.description,
        severity: body.severity,
        group: body.group,
        condition: body.condition,
        threshold: body.threshold,
        enabled: body.enabled,
        hysteresis: body.hysteresis,
        confirm_ms: body.confirm_ms,
    }
}

async fn save_alarm_rule(
    repo: &Repo,
    alarm_engine: &AlarmEngine,
    engine: &RedundancyEngine,
    rule: AlarmRule,
) -> Result<Json<AlarmRule>, StatusCode> {
    let row: AlarmRuleRow = (&rule).into();
    repo.insert_alarm_rule(&row).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    alarm_engine.set_rule(rule.clone());
    bump_version_and_push(repo, engine).await;
    Ok(Json(rule))
}

pub async fn upsert_alarm_rule(
    State(repo): State<AppState>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<AlarmRuleUpsert>,
) -> Result<Json<AlarmRule>, StatusCode> {
    let rule = rule_from_upsert(body, None);
    save_alarm_rule(&repo, &alarm_engine, &engine, rule).await
}

pub async fn update_alarm_rule(
    State(repo): State<AppState>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<String>,
    Json(body): Json<AlarmRuleUpsert>,
) -> Result<Json<AlarmRule>, StatusCode> {
    let rule = rule_from_upsert(body, Some(id));
    save_alarm_rule(&repo, &alarm_engine, &engine, rule).await
}

pub async fn delete_alarm_rule(
    State(repo): State<AppState>,
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    alarm_engine.remove_rule(&id);
    repo.delete_alarm_rule(&id).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    bump_version_and_push(&repo, &engine).await;
    Ok(StatusCode::OK)
}

pub async fn alarm_active(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
) -> Json<Vec<AlarmOccurrence>> {
    Json(alarm_engine.active_occurrences())
}

#[derive(Deserialize)]
pub struct AlarmHistoryQuery {
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub severity: Option<String>,
    pub group: Option<String>,
    pub variable_id: Option<String>,
    pub status: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub async fn alarm_history(
    State(repo): State<AppState>,
    Query(q): Query<AlarmHistoryQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (total, rows) = repo
        .query_alarm_occurrences(
            q.from,
            q.to,
            q.severity.as_deref(),
            q.group.as_deref(),
            q.variable_id.as_deref(),
            q.status.as_deref(),
            q.page.unwrap_or(1),
            q.page_size.unwrap_or(50),
        )
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let items: Vec<AlarmOccurrence> = rows.into_iter().map(AlarmOccurrence::from).collect();
    Ok(Json(serde_json::json!({ "total": total, "items": items })))
}

pub async fn alarm_occurrence_events(
    State(repo): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<AlarmStreamEvent>>, StatusCode> {
    let items: Vec<AlarmStreamEvent> = repo
        .query_occurrence_stream_events(&id)
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .into_iter()
        .map(AlarmStreamEvent::from)
        .collect();
    Ok(Json(items))
}

#[derive(Deserialize)]
pub struct SoeQuery {
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub variable_id: Option<String>,
    pub quality: Option<String>,
    pub page: Option<u64>,
    pub page_size: Option<u64>,
}

pub async fn soe_query(
    State(repo): State<AppState>,
    Query(q): Query<SoeQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (total, rows) = repo
        .query_soe(
            q.from,
            q.to,
            q.variable_id.as_deref(),
            q.quality.as_deref(),
            q.page.unwrap_or(1),
            q.page_size.unwrap_or(50),
        )
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let items: Vec<hmi_io_alarm::types::SoeRecord> =
        rows.into_iter().map(hmi_io_alarm::types::SoeRecord::from).collect();
    Ok(Json(serde_json::json!({ "total": total, "items": items })))
}

#[derive(Deserialize)]
pub struct AckBody {
    pub id: String,
    pub user: String,
}

pub async fn alarm_ack(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Json(body): Json<AckBody>,
) -> Result<StatusCode, StatusCode> {
    if alarm_engine.ack(&body.id, &body.user) {
        Ok(StatusCode::OK)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

#[derive(Deserialize)]
pub struct AckAllBody {
    pub user: String,
}

pub async fn alarm_ack_all(
    Extension(alarm_engine): Extension<Arc<AlarmEngine>>,
    Json(body): Json<AckAllBody>,
) -> Json<serde_json::Value> {
    let n = alarm_engine.ack_all(&body.user);
    Json(serde_json::json!({ "acknowledged": n }))
}

#[derive(Serialize, Deserialize)]
pub struct AlarmConfigBody {
    pub alarm_retention_days: u32,
    pub soe_retention_days: u32,
}

pub async fn get_alarm_config(
    State(repo): State<AppState>,
) -> Json<AlarmConfigBody> {
    Json(AlarmConfigBody {
        alarm_retention_days: repo
            .get_config("alarm_retention_days")
            .and_then(|v| v.parse().ok())
            .unwrap_or(90),
        soe_retention_days: repo
            .get_config("soe_retention_days")
            .and_then(|v| v.parse().ok())
            .unwrap_or(30),
    })
}

pub async fn put_alarm_config(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<AlarmConfigBody>,
) -> Result<StatusCode, StatusCode> {
    repo.set_config("alarm_retention_days", &body.alarm_retention_days.to_string())
        .and_then(|_| repo.set_config("soe_retention_days", &body.soe_retention_days.to_string()))
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    if let Err(e) = repo.prune_alarm_data(body.alarm_retention_days as u64, body.soe_retention_days as u64)
    {
        log::error!("prune alarm data failed: {}", e);
    }
    bump_version_and_push(&repo, &engine).await;
    Ok(StatusCode::OK)
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

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_config::{AppConfig, PluginInstance, PointMapping};

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
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let pid = repo
            .insert_plugin("modbus_tcp", "modbus_tcp.wasm", "{}")
            .unwrap();
        repo.insert_point(pid, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "")
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
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let p1 = repo.insert_plugin("mb1", "modbus.wasm", "{}").unwrap();
        let p2 = repo.insert_plugin("mb2", "modbus.wasm", "{}").unwrap();
        repo.insert_point(p1, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();
        repo.insert_point(p2, "P1", "coil:1", "bool", "big_endian", 1.0, 0.0, "DI", "")
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
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let p1 = repo
            .insert_plugin_full("mb1", "mb.wasm", "{}", "mb-link", "primary", 0)
            .unwrap();
        let p2 = repo
            .insert_plugin_full("mb2", "mb.wasm", "{}", "mb-link", "backup", 1)
            .unwrap();
        repo.insert_point(p1, "P1", "a", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();
        repo.insert_point(p2, "P1", "b", "bool", "big_endian", 1.0, 0.0, "DI", "")
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

    #[test]
    fn build_config_snapshot_includes_all_fields() {
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let pid = repo
            .insert_plugin("mb", "mb.wasm", "{\"host\":\"x\"}")
            .unwrap();
        repo.insert_point(pid, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "d")
            .unwrap();
        repo.set_config("config_version", "3").unwrap();
        repo.set_config("redundancy_config", r#"{"enabled":true}"#)
            .unwrap();

        let snap = build_config_snapshot(&repo);
        assert_eq!(snap.config_version, 3);
        assert_eq!(snap.plugins.len(), 1);
        assert_eq!(snap.plugins[0].name, "mb");
        assert_eq!(snap.plugins[0].points[0].variable_id, "P1");
        assert_eq!(snap.redundancy["enabled"], serde_json::Value::Bool(true));
    }

    #[test]
    fn alarm_rule_id_is_generated_when_absent() {
        let body = AlarmRuleUpsert {
            id: None,
            variable_id: "P1".into(),
            name: "测试".into(),
            description: String::new(),
            severity: hmi_io_alarm::types::Severity::Major,
            group: String::new(),
            condition: hmi_io_alarm::types::Condition::High,
            threshold: 100.0,
            enabled: true,
            hysteresis: 0.0,
            confirm_ms: 0,
        };
        let r1 = rule_from_upsert(body, None);
        assert!(r1.id.starts_with("rule_"));
        let body2 = AlarmRuleUpsert {
            id: Some("body-id".into()),
            variable_id: "P2".into(),
            name: String::new(),
            description: String::new(),
            severity: hmi_io_alarm::types::Severity::Warning,
            group: String::new(),
            condition: hmi_io_alarm::types::Condition::Low,
            threshold: 1.0,
            enabled: false,
            hysteresis: 1.0,
            confirm_ms: 500,
        };
        let r2 = rule_from_upsert(body2, Some("path-id".into()));
        assert_eq!(r2.id, "path-id");
        let r3 = rule_from_upsert(
            AlarmRuleUpsert {
                id: Some("body-id".into()),
                variable_id: "P3".into(),
                name: String::new(),
                description: String::new(),
                severity: hmi_io_alarm::types::Severity::Minor,
                group: String::new(),
                condition: hmi_io_alarm::types::Condition::NotEqual,
                threshold: 0.0,
                enabled: true,
                hysteresis: 0.0,
                confirm_ms: 0,
            },
            None,
        );
        assert_eq!(r3.id, "body-id");
    }
}
