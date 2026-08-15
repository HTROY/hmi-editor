use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post, put},
    Extension, Router,
};
use hmi_io_alarm::engine::AlarmEngine;
use hmi_io_auth::model::{require_auth, require_project_permission};
use hmi_io_auth::AuthService;
use hmi_io_db::repo::Repo;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
use hmi_io_point::redundancy::RedundancyEngine;
use hmi_io_project::ProjectStore;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use super::api::alarms;
use super::api::config;
use super::api::excel;
use super::api::monitor;
use super::api::plugins;
use super::api::points;
use super::api::redundancy;

pub async fn run_web_server(
    repo: Arc<Repo>,
    monitor: Arc<MonitorCollector>,
    registry: Arc<PluginRegistry>,
    broadcast_tx: broadcast::Sender<String>,
    point_manager: Arc<Mutex<PointManager>>,
    redundancy: Arc<RedundancyEngine>,
    alarm_engine: Arc<AlarmEngine>,
    auth: Arc<AuthService>,
    port: u16,
) -> anyhow::Result<()> {
    let project_dir = repo
        .get_config("project_dir")
        .await
        .unwrap_or_else(|| "./projects".into());
    let project_store = ProjectStore::new(repo.clone(), project_dir)?;

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
            get(plugins::list_plugins).post(plugins::create_plugin),
        )
        .route(
            "/api/plugins/{id}",
            get(plugins::get_plugin)
                .put(plugins::update_plugin)
                .delete(plugins::delete_plugin),
        )
        // Point CRUD
        .route(
            "/api/points",
            get(points::list_points).post(points::create_point),
        )
        .route(
            "/api/points/{id}",
            put(points::update_point).delete(points::delete_point),
        )
        // Excel import/export
        .route("/api/plugins/{plugin_id}/import", post(excel::import_excel))
        .route("/api/plugins/{plugin_id}/export", get(excel::export_excel))
        // Config export
        .route("/api/config/export", get(config::export_config))
        // Redundancy API
        .route(
            "/api/redundancy/config",
            get(redundancy::get_redundancy_config).put(redundancy::update_redundancy_config),
        )
        .route(
            "/api/redundancy/config/push",
            post(redundancy::apply_config_push),
        )
        .route(
            "/api/redundancy/heartbeat",
            get(redundancy::redundancy_heartbeat),
        )
        .route("/api/redundancy/sync", post(redundancy::redundancy_sync))
        .route(
            "/api/redundancy/snapshot",
            get(redundancy::redundancy_snapshot),
        )
        .route("/api/redundancy/claim", post(redundancy::redundancy_claim))
        .route("/api/redundancy/status", get(redundancy::redundancy_status))
        .route(
            "/api/redundancy/instance-groups",
            get(redundancy::redundancy_instance_groups),
        )
        // Monitor API
        .route("/api/monitor/overview", get(monitor::monitor_overview))
        .route(
            "/api/monitor/plugins/{name}/status",
            get(monitor::monitor_plugin_status),
        )
        .route(
            "/api/monitor/plugins/{name}/points",
            get(monitor::monitor_plugin_points),
        )
        .route(
            "/api/monitor/plugins/{name}/packets",
            get(monitor::monitor_plugin_packets),
        )
        .route("/api/monitor/history", get(monitor::monitor_history))
        // Alarm & SOE API
        .route(
            "/api/alarm/rules",
            get(alarms::list_alarm_rules).post(alarms::upsert_alarm_rule),
        )
        .route(
            "/api/alarm/rules/{id}",
            axum::routing::put(alarms::update_alarm_rule).delete(alarms::delete_alarm_rule),
        )
        .route("/api/alarm/active", get(alarms::alarm_active))
        .route("/api/alarm/history", get(alarms::alarm_history))
        .route(
            "/api/alarm/occurrences/{id}/events",
            get(alarms::alarm_occurrence_events),
        )
        .route("/api/alarm/ack", post(alarms::alarm_ack))
        .route("/api/alarm/ack-all", post(alarms::alarm_ack_all))
        .route(
            "/api/alarm/config",
            get(alarms::get_alarm_config).put(alarms::put_alarm_config),
        )
        .route("/api/soe", get(alarms::soe_query))
        .merge(auth_routes(auth.clone()))
        .merge(project_routes(project_store, auth))
        // Static files (SPA fallback to index.html)
        .fallback_service(
            ServeDir::new("web-ui/dist").fallback(ServeFile::new("web-ui/dist/index.html")),
        )
        .layer(CorsLayer::permissive())
        .layer(Extension(monitor))
        .layer(Extension(registry))
        .layer(Extension(broadcast_tx))
        .layer(Extension(point_manager))
        .layer(Extension(redundancy))
        .layer(Extension(alarm_engine))
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

pub(crate) fn auth_routes(auth: Arc<AuthService>) -> Router<Arc<Repo>> {
    Router::<Arc<Repo>>::new()
        .route("/api/auth/login", post(super::auth::login))
        .route("/api/auth/refresh", post(super::auth::refresh))
        .route(
            "/api/auth/change-password",
            post(super::auth::change_password).layer(axum::middleware::from_fn_with_state(
                auth.clone(),
                require_auth,
            )),
        )
        .layer(Extension(auth))
}

pub(crate) fn project_routes(store: ProjectStore, auth: Arc<AuthService>) -> Router<Arc<Repo>> {
    Router::<Arc<Repo>>::new()
        .route("/api/projects", get(super::projects::list_projects))
        .route(
            "/api/projects/{id}",
            get(super::projects::get_project)
                .put(super::projects::put_project)
                .delete(super::projects::delete_project),
        )
        .route_layer(DefaultBodyLimit::max(hmi_io_project::MAX_PROJECT_ZIP_SIZE))
        .layer(axum::middleware::from_fn(require_project_permission))
        .layer(axum::middleware::from_fn_with_state(auth, require_auth))
        .layer(Extension(store))
}
