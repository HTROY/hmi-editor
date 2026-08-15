//! Plugin CRUD handlers.

use super::{api_error, bump_version_and_push, AppState};
use axum::{
    extract::{Extension, Json, Path, State},
    http::StatusCode,
};
use hmi_io_db::repo::{PluginRow, Repo};
use hmi_io_point::redundancy::RedundancyEngine;
use serde::Deserialize;
use std::sync::Arc;

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

async fn validate_group_edit(
    repo: &Repo,
    candidate: &UpsertPlugin,
    edit_id: Option<i64>,
) -> Result<(), StatusCode> {
    let mut plugins = repo.list_plugins().await.map_err(api_error)?;
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
    let mut instances: Vec<hmi_io_config::PluginInstance> = Vec::new();
    for p in plugins {
        let points = repo
            .list_points(Some(p.id))
            .await
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
        instances.push(hmi_io_config::PluginInstance {
            name: p.name,
            wasm_file: p.wasm_file,
            config: serde_json::from_str(&p.config_json).unwrap_or(serde_json::json!({})),
            points,
            redundancy_group: p.redundancy_group,
            redundancy_role: p.redundancy_role,
            priority: p.priority,
        });
    }
    let mut cfg = hmi_io_config::AppConfig::default_config();
    cfg.plugins.instances = instances;
    cfg.validate().map_err(|e| {
        log::warn!("group validation failed: {}", e);
        StatusCode::BAD_REQUEST
    })
}

pub async fn list_plugins(
    State(repo): State<AppState>,
) -> Result<Json<Vec<PluginRow>>, StatusCode> {
    let rows = repo.list_plugins().await.map_err(api_error)?;
    Ok(Json(rows))
}

pub async fn get_plugin(
    State(repo): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<PluginRow>, StatusCode> {
    match repo.get_plugin(id).await.map_err(api_error)? {
        Some(p) => Ok(Json(p)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

pub async fn create_plugin(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(p): Json<UpsertPlugin>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    validate_group_edit(&repo, &p, None).await?;
    let id = repo
        .insert_plugin_full(
            &p.name,
            &p.wasm_file,
            &p.config_json,
            &p.redundancy_group,
            &p.redundancy_role,
            p.priority,
        )
        .await
        .map_err(api_error)?;
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(Json(serde_json::json!({"id": id})))
}

pub async fn update_plugin(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<i64>,
    Json(p): Json<UpsertPlugin>,
) -> Result<StatusCode, StatusCode> {
    validate_group_edit(&repo, &p, Some(id)).await?;
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
    .await
    .map_err(api_error)?;
    bump_version_and_push(repo.clone(), engine.clone()).await;
    Ok(StatusCode::OK)
}

pub async fn delete_plugin(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Path(id): Path<i64>,
) -> StatusCode {
    match repo.delete_plugin(id).await {
        Ok(()) => {
            bump_version_and_push(repo.clone(), engine.clone()).await;
            StatusCode::OK
        }
        Err(e) => api_error(e),
    }
}
