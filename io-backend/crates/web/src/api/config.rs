//! Config export handlers.

use super::{api_error, AppState};
use axum::{extract::State, http::StatusCode, response::Json};
use serde::Serialize;

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
    let pws = repo.list_plugins_with_points().await.map_err(api_error)?;
    let scan_ms: u64 = repo
        .get_config("scan_interval_ms")
        .await
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
