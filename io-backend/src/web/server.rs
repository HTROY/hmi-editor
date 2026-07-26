use std::sync::Arc;
use axum::{Router, routing::{get, post, put}, Extension};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tokio::sync::broadcast;
use crate::db::repo::Repo;
use crate::monitor::collector::MonitorCollector;
use crate::plugin::registry::PluginRegistry;

pub async fn run_web_server(
    repo: Arc<Repo>,
    monitor: Arc<MonitorCollector>,
    _registry: Arc<PluginRegistry>,
    broadcast_tx: broadcast::Sender<String>,
    port: u16,
) -> anyhow::Result<()> {
    let app = Router::new()
        // Plugin CRUD
        .route("/api/plugins", get(super::api::list_plugins).post(super::api::create_plugin))
        .route("/api/plugins/{id}", get(super::api::get_plugin).put(super::api::update_plugin).delete(super::api::delete_plugin))
        // Point CRUD
        .route("/api/points", get(super::api::list_points).post(super::api::create_point))
        .route("/api/points/{id}", put(super::api::update_point).delete(super::api::delete_point))
        // Excel import/export
        .route("/api/plugins/{plugin_id}/import", post(super::api::import_excel))
        .route("/api/plugins/{plugin_id}/export", get(super::api::export_excel))
        // Config export
        .route("/api/config/export", get(super::api::export_config))
        // Monitor API
        .route("/api/monitor/overview", get(super::api::monitor_overview))
        .route("/api/monitor/plugins/{name}/status", get(super::api::monitor_plugin_status))
        .route("/api/monitor/plugins/{name}/points", get(super::api::monitor_plugin_points))
        .route("/api/monitor/plugins/{name}/packets", get(super::api::monitor_plugin_packets))
        // Static files
        .fallback_service(ServeDir::new("web-ui"))
        .layer(CorsLayer::permissive())
        .layer(Extension(monitor))
        .layer(Extension(_registry))
        .layer(Extension(broadcast_tx))
        .with_state(repo);

    let addr = format!("0.0.0.0:{}", port);
    log::info!("Management UI on http://{}", addr);
    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(addr.parse()?)?;
    let listener = socket.listen(1024)?;
    axum::serve(listener, app).await?;
    Ok(())
}
