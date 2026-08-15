//! Point CRUD handlers.

use super::{api_error, bump_version_and_push, send_config_change, AppState};
use axum::{
    extract::{Extension, Json, Path, Query, State},
    http::StatusCode,
};
use hmi_io_db::repo::PointRow;
use hmi_io_point::logical_key;
use hmi_io_point::manager::PointManager;
use hmi_io_point::redundancy::RedundancyEngine;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

#[derive(Deserialize)]
pub struct PluginQuery {
    pub plugin_id: Option<i64>,
    pub include_backup: Option<bool>,
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
    pub redundancy_role: String,
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
            redundancy_role: row.redundancy_role,
        }
    }
}

fn hmi_id_for_point(p: &PointRow) -> String {
    // 逻辑键推导统一走点位身份规则（组内以组名为前缀）
    logical_key(&p.redundancy_group, &p.plugin_name, &p.variable_id)
}

pub async fn list_points(
    State(repo): State<AppState>,
    Extension(point_manager): Extension<Arc<Mutex<PointManager>>>,
    Query(q): Query<PluginQuery>,
) -> Result<Json<Vec<PointView>>, StatusCode> {
    let include_backup = q.include_backup.unwrap_or(false);
    let all_points = repo.list_points(q.plugin_id).await.map_err(api_error)?;
    let total_in_db = all_points.len();
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
        .await
        .map(|id| Json(serde_json::json!({"id": id})))
        .map_err(api_error)?;
    send_config_change(&broadcast_tx, "create", &var_id, plugin_id);
    bump_version_and_push(repo.clone(), engine.clone()).await;
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
    .await
    .map(|_| StatusCode::OK)
    .map_err(api_error)?;
    send_config_change(&broadcast_tx, "update", &var_id, plugin_id);
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(StatusCode::OK)
}

pub async fn delete_point(
    State(repo): State<AppState>,
    Extension(broadcast_tx): Extension<broadcast::Sender<String>>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, StatusCode> {
    // Get point info before deletion for the notification
    let point_info = repo.get_point(id).await.map_err(api_error)?;
    let (plugin_id, var_id) = match &point_info {
        Some(p) => (p.plugin_id, p.variable_id.clone()),
        None => (0, String::new()),
    };
    repo.delete_point(id).await.map_err(api_error)?;
    if !var_id.is_empty() {
        send_config_change(&broadcast_tx, "delete", &var_id, plugin_id);
    }
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(StatusCode::OK)
}
