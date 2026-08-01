use hmi_io_bridge::bridge::Bridge;
use hmi_io_config::AppConfig;
use hmi_io_db::repo::Repo;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
use std::sync::{Arc, Mutex};

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    log::info!("=== HMI I/O Backend v{} ===", env!("CARGO_PKG_VERSION"));

    let db_path = "hmi_io.db";
    let repo = Repo::new(db_path)?;
    log::info!("Database: {}", db_path);

    let monitor = MonitorCollector::new();

    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.yaml".to_string());
    let app_config = build_config(&repo, &config_path);

    let ws_port: u16 = repo
        .get_config("ws_port")
        .unwrap_or_else(|| "8080".into())
        .parse()
        .unwrap_or(8080);
    let web_port: u16 = repo
        .get_config("web_port")
        .unwrap_or_else(|| "8081".into())
        .parse()
        .unwrap_or(8081);
    let batch_interval_ms: u64 = repo
        .get_config("batch_interval_ms")
        .unwrap_or_else(|| "100".into())
        .parse()
        .unwrap_or(100);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()?;

    rt.block_on(async move {
        let registry = PluginRegistry::new(monitor.clone())?;
        registry.init_from_config(&app_config).await?;
        let point_manager = Arc::new(Mutex::new(PointManager::from_config(&app_config)));
        let point_rx = registry
            .take_point_receiver()
            .ok_or_else(|| anyhow::anyhow!("no point rx"))?;
        let (bridge, broadcast_tx) =
            Bridge::new(point_rx, point_manager.clone(), batch_interval_ms);
        let registry_arc = Arc::new(registry);
        tokio::spawn(async move {
            bridge.run().await;
        });
        let statuses = registry_arc.plugin_statuses().await;
        for (n, s) in &statuses {
            log::info!("  Plugin '{}': {}", n, s);
        }

        let repo_arc = Arc::new(repo);
let ws_cfg = hmi_io_config::ServerConfig {
            host: repo_arc
                .get_config("ws_host")
                .unwrap_or_else(|| "0.0.0.0".into()),
            port: ws_port,
            path: "/iscs/data".into(),
            batch_interval_ms,
        };

        // Clone broadcast_tx for multiple consumers
        let bc_ws = broadcast_tx.clone();
        let bc_web = broadcast_tx.clone();

        // Spawn WebSocket server (critical - keep handle to await)
        let reg_ws = registry_arc.clone();
        let pm_ws = point_manager.clone();
        let mon_ws = monitor.clone();
        let ws_h = tokio::spawn(async move {
            log::info!(
                "WS data server on ws://{}:{}{}",
                ws_cfg.host,
                ws_cfg.port,
                ws_cfg.path
            );
            if let Err(e) =
        hmi_io_server::ws::run_server(&ws_cfg, bc_ws, reg_ws, pm_ws, mon_ws).await
            {
                log::error!("WS fatal: {}", e);
            }
        });

        // Spawn Web UI (non-critical - detach, errors are self-logged)
        let web_port_clone = web_port;
        let web_monitor = monitor.clone();
        let reg_web = registry_arc.clone();
        let pm_web = point_manager.clone();
        tokio::spawn(async move {
            log::info!("Web UI starting on port {}...", web_port_clone);
            match hmi_io_web::server::run_web_server(
                repo_arc,
                web_monitor,
                reg_web,
                bc_web,
                pm_web,
                web_port_clone,
            )
            .await
            {
                Ok(()) => log::info!("Web UI stopped normally"),
                Err(e) => log::error!("Web UI error: {:#}", e),
            }
        });

        log::info!("=== Ready ===");
        log::info!("  Data WS:      ws://localhost:{}/iscs/data", ws_port);
        log::info!("  Web UI:       http://localhost:{}", web_port);
        log::info!(
            "  Monitor API:  http://localhost:{}/api/monitor/overview",
            web_port
        );

        // Wait for Ctrl+C or critical WS server failure
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                log::info!("Received Ctrl+C, shutting down...");
            }
            r = ws_h => {
                log::error!("WS server exited unexpectedly: {:?}", r);
                log::info!("Shutting down...");
            }
        }
        registry_arc.shutdown();
        log::info!("=== Shutdown complete ===");
        Ok::<(), anyhow::Error>(())
    })?;
    Ok(())
}

fn build_config(repo: &Repo, yaml_path: &str) -> AppConfig {
    if let Ok(plugins) = repo.list_plugins() {
        if !plugins.is_empty() {
            log::info!("Loading config from database");
            return AppConfig::from_repo_sync(repo);
        }
    }
    log::info!("Loading config from {}", yaml_path);
    let app_config = match AppConfig::load(yaml_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!("YAML load failed ({}), using defaults", e);
            let d = AppConfig::default_config();
            let _ = std::fs::write(yaml_path, serde_yaml::to_string(&d).unwrap_or_default());
            d
        }
    };
    migrate_yaml_to_db(repo, &app_config);
    app_config
}

fn migrate_yaml_to_db(repo: &Repo, config: &AppConfig) {
    log::info!("Migrating YAML to DB...");
    let _ = repo.set_config(
        "scan_interval_ms",
        &config.plugins.scan_interval_ms.to_string(),
    );
    let _ = repo.set_config(
        "batch_interval_ms",
        &config.server.batch_interval_ms.to_string(),
    );
    let _ = repo.set_config("plugin_dir", &config.plugins.directory);
    for inst in &config.plugins.instances {
        let cj = serde_json::to_string(&inst.config).unwrap_or_else(|_| "{}".into());
        match repo.insert_plugin(&inst.name, &inst.wasm_file, &cj) {
            Ok(pid) => {
                for pt in &inst.points {
                    let _ = repo.insert_point(
                        pid,
                        &pt.id,
                        &pt.address,
                        &pt.data_type,
                        &pt.byte_order,
                        pt.scale,
                        pt.offset,
                        &pt.var_type,
                        "",
                    );
                }
                log::info!("  Migrated '{}': {} points", inst.name, inst.points.len());
            }
            Err(e) => log::warn!("  Skip '{}': {}", inst.name, e),
        }
    }
}
