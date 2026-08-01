use hmi_io_db::repo::Repo;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
use axum::{
    routing::{get, post, put},
    Extension, Router,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

pub async fn run_web_server(
    repo: Arc<Repo>,
    monitor: Arc<MonitorCollector>,
    _registry: Arc<PluginRegistry>,
    broadcast_tx: broadcast::Sender<String>,
    point_manager: Arc<Mutex<PointManager>>,
    port: u16,
) -> anyhow::Result<()> {
    // Sampler task: keep the trend history continuous regardless of UI clients
    {
        let monitor = monitor.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                monitor.sample();
            }
        });
    }

    let app = Router::new()
        // Plugin CRUD
        .route(
            "/api/plugins",
            get(super::api::list_plugins).post(super::api::create_plugin),
        )
        .route(
            "/api/plugins/{id}",
            get(super::api::get_plugin)
                .put(super::api::update_plugin)
                .delete(super::api::delete_plugin),
        )
        // Point CRUD
        .route(
            "/api/points",
            get(super::api::list_points).post(super::api::create_point),
        )
        .route(
            "/api/points/{id}",
            put(super::api::update_point).delete(super::api::delete_point),
        )
        // Excel import/export
        .route(
            "/api/plugins/{plugin_id}/import",
            post(super::api::import_excel),
        )
        .route(
            "/api/plugins/{plugin_id}/export",
            get(super::api::export_excel),
        )
        // Config export
        .route("/api/config/export", get(super::api::export_config))
        // Monitor API
        .route("/api/monitor/overview", get(super::api::monitor_overview))
        .route(
            "/api/monitor/plugins/{name}/status",
            get(super::api::monitor_plugin_status),
        )
        .route(
            "/api/monitor/plugins/{name}/points",
            get(super::api::monitor_plugin_points),
        )
        .route(
            "/api/monitor/plugins/{name}/packets",
            get(super::api::monitor_plugin_packets),
        )
        .route("/api/monitor/history", get(super::api::monitor_history))
        // Static files (SPA fallback to index.html)
        .fallback_service(
            ServeDir::new("web-ui/dist").fallback(ServeFile::new("web-ui/dist/index.html")),
        )
        .layer(CorsLayer::permissive())
        .layer(Extension(monitor))
        .layer(Extension(_registry))
        .layer(Extension(broadcast_tx))
        .layer(Extension(point_manager))
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
