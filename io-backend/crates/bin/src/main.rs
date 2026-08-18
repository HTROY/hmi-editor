use hmi_io_alarm::engine::AlarmEngine;
use hmi_io_alarm::types::AlarmRule;
use hmi_io_bridge::bridge::Bridge;
use hmi_io_config::AppConfig;
use hmi_io_db::repo::Repo;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
use hmi_io_point::redundancy::{NodeState, RedundancyEngine, RoleCommand};
use std::sync::{Arc, Mutex};
use sync_util::MutexExt;
use tokio::sync::mpsc;

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    log::info!("=== HMI I/O Backend v{} ===", env!("CARGO_PKG_VERSION"));

    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.yaml".to_string());

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(8)
        .enable_all()
        .build()?;

    rt.block_on(async move {
        let db_path = "hmi_io.db";
        let repo = Repo::new(db_path).await?;
        log::info!("Database: {}", db_path);
        let repo_arc = Arc::new(repo);

        if let Some(initial_password) =
            hmi_io_auth::ensure_admin_seeded(repo_arc.as_ref()).await?
        {
            log::warn!(
                "Seeded initial admin user: username=admin password={} (must change on first login)",
                initial_password
            );
        }
        let auth = Arc::new(hmi_io_auth::AuthService::for_repo(repo_arc.as_ref()).await?);

        let monitor = MonitorCollector::new();

        let app_config = build_config(repo_arc.as_ref(), &config_path).await?;

        let ws_port: u16 = repo_arc
            .get_config("ws_port")
            .await
            .unwrap_or_else(|| "8080".into())
            .parse()
            .unwrap_or(app_config.server.port);
        let web_port: u16 = repo_arc
            .get_config("web_port")
            .await
            .unwrap_or_else(|| "8081".into())
            .parse()
            .unwrap_or(app_config.server.web_port);
        let batch_interval_ms: u64 = repo_arc
            .get_config("batch_interval_ms")
            .await
            .unwrap_or_else(|| "100".into())
            .parse()
            .unwrap_or(100);

        // Alarm engine: IO-free state machine + persister task.
        let (alarm_tx, alarm_rx) = mpsc::unbounded_channel::<hmi_io_alarm::types::OutEvent>();
        let alarm_engine = AlarmEngine::with_soe_seq(alarm_tx, repo_arc.max_soe_seq().await);
        let rules: Vec<AlarmRule> = repo_arc
            .list_alarm_rules()
            .await
            .map(|rows| rows.into_iter().map(AlarmRule::from).collect())
            .unwrap_or_else(|e| {
                log::error!("Load alarm rules failed: {}", e);
                vec![]
            });
        alarm_engine.load_rules(rules);
        let active = repo_arc
            .list_active_alarm_occurrences()
            .await
            .map(|rows| rows.into_iter().map(hmi_io_alarm::types::AlarmOccurrence::from).collect())
            .unwrap_or_default();
        let recovered_unacked = repo_arc
            .list_recovered_unacked()
            .await
            .map(|rows| rows.into_iter().map(hmi_io_alarm::types::AlarmOccurrence::from).collect())
            .unwrap_or_default();
        alarm_engine.restore_occurrences(active, recovered_unacked);

        let registry = Arc::new(PluginRegistry::new(monitor.clone())?);
        let point_manager = Arc::new(Mutex::new(PointManager::from_config(&app_config)));
        let point_rx = registry
            .take_point_receiver()
            .ok_or_else(|| anyhow::anyhow!("no point rx"))?;
        let (bridge, broadcast_tx) = Bridge::new(
            point_rx,
            point_manager.clone(),
            batch_interval_ms,
            Some(alarm_engine.clone()),
        );
        let persister = hmi_io_alarm::persist::spawn_persister(
            alarm_rx,
            repo_arc.clone(),
            broadcast_tx.clone(),
        );

        // Periodic confirm-candidate finalization (100ms) and retention prune (1h).
        {
            let eng = alarm_engine.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
                loop {
                    tick.tick().await;
                    eng.tick();
                }
            });
        }
        {
            let repo_for_prune = repo_arc.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
                loop {
                    interval.tick().await;
                    let alarm_days: u64 = repo_for_prune
                        .get_config("alarm_retention_days")
                        .await
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(90);
                    let soe_days: u64 = repo_for_prune
                        .get_config("soe_retention_days")
                        .await
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(30);
                    match repo_for_prune.prune_alarm_data(alarm_days, soe_days).await {
                        Ok((a, s)) => log::info!("Pruned alarm/SOE rows: {}/{}", a, s),
                        Err(e) => log::error!("Prune alarm data failed: {}", e),
                    }
                }
            });
        }

        // 冗余引擎：始终构造（disabled 时引擎空转，行为与单机一致）
        let redundancy = RedundancyEngine::new(
            app_config.redundancy.clone(),
            point_manager.clone(),
            broadcast_tx.subscribe(),
            broadcast_tx.clone(),
        );
        let (role_tx, mut role_rx) = mpsc::unbounded_channel::<RoleCommand>();
        redundancy.set_role_tx(role_tx);

        // 初始角色决策：探测对端，Standby 不启动插件
        let initial_state = redundancy.decide_initial_state().await;
        redundancy.apply_initial_state(initial_state);
        registry.prepare(&app_config).await?;
        registry.set_point_manager(point_manager.clone());
        redundancy.set_health_provider(Box::new({
            let mon = monitor.clone();
            let scan = app_config.plugins.scan_interval_ms.max(100);
            move || {
                let snap = mon.get_snapshot();
                let total = snap.plugins.len();
                let connected = snap
                    .plugins
                    .iter()
                    .filter(|p| p.connection_state == 2)
                    .count();
                let fresh = snap.plugins.iter().any(|p| {
                    p.connection_state == 2
                        && snap.server_uptime_ms.saturating_sub(p.last_scan_time_ms) < scan * 3
                });
                (total, connected, fresh)
            }
        }));
        if let Some(h) = registry.spawn_instance_supervisor(app_config.plugins.scan_interval_ms) {
            let _ = h;
        }
        if initial_state == NodeState::Active {
            registry.start_instances(&app_config).await?;
            alarm_engine.rebuild(&point_manager.lock_recover().get_all_values());
        } else {
            log::info!("Node starts as STANDBY, plugins deferred until promotion");
        }

        tokio::spawn(async move {
            bridge.run().await;
        });
        let statuses = registry.plugin_statuses().await;
        for (n, s) in &statuses {
            log::info!("  Plugin '{}': {}", n, s);
        }

        let engine_task = {
            let r = redundancy.clone();
            tokio::spawn(async move { r.run().await })
        };

        let repo_for_roles = repo_arc.clone();
        let reg_for_roles = registry.clone();
        let mon_for_roles = monitor.clone();
        let alarm_for_roles = alarm_engine.clone();
        let pm_for_roles = point_manager.clone();
        let role_task = tokio::spawn(async move {
            while let Some(cmd) = role_rx.recv().await {
                match cmd {
                    RoleCommand::Promote => {
                        log::info!("Role command: PROMOTE");
                        let cfg = hmi_io_config::AppConfig::from_repo(&repo_for_roles).await;
                        match reg_for_roles.start_instances(&cfg).await {
                            Ok(()) => {
                                log::info!("Plugins started after promotion");
                                let rules: Vec<AlarmRule> = repo_for_roles
                                    .list_alarm_rules()
                                    .await
                                    .map(|rows| {
                                        rows.into_iter().map(AlarmRule::from).collect()
                                    })
                                    .unwrap_or_default();
                                alarm_for_roles.replace_rules(rules);
                                alarm_for_roles
                                    .rebuild(&pm_for_roles.lock_recover().get_all_values());
                            }
                            Err(e) => {
                                log::error!("Failed to start plugins after promotion: {}", e)
                            }
                        }
                    }
                    RoleCommand::Demote => {
                        log::info!("Role command: DEMOTE");
                        reg_for_roles.shutdown();
                    }
                    RoleCommand::ProbeData { reply } => {
                        log::info!("Role command: PROBE DATA");
                        let cfg = hmi_io_config::AppConfig::from_repo(&repo_for_roles).await;
                        let ok = async {
                            if reg_for_roles.start_instances(&cfg).await.is_err() {
                                return false;
                            }
                            // 轮询等待插件真正连上（iec104 握手可能耗时数秒）
                            let deadline =
                                std::time::Instant::now() + std::time::Duration::from_secs(8);
                            let mut any;
                            loop {
                                let snap = mon_for_roles.get_snapshot();
                                any = snap.plugins.iter().any(|p| p.connection_state == 2);
                                if any || std::time::Instant::now() >= deadline {
                                    break;
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            }
                            reg_for_roles.shutdown();
                            any
                        }
                        .await;
                        let _ = reply.send(ok);
                    }
                }
            }
        });
        let ws_cfg = hmi_io_config::ServerConfig {
            host: repo_arc
                .get_config("ws_host")
                .await
                .unwrap_or_else(|| "0.0.0.0".into()),
            port: ws_port,
            web_port,
            path: "/iscs/data".into(),
            project_dir: repo_arc
                .get_config("project_dir")
                .await
                .unwrap_or_else(|| "./projects".into()),
            batch_interval_ms,
        };

        // Clone broadcast_tx for multiple consumers
        let bc_ws = broadcast_tx.clone();
        let bc_web = broadcast_tx.clone();

        // Spawn WebSocket server (critical - keep handle to await)
        let reg_ws = registry.clone();
        let pm_ws = point_manager.clone();
        let mon_ws = monitor.clone();
        let alarm_ws = alarm_engine.clone();
        let ws_h = tokio::spawn(async move {
            log::info!(
                "WS data server on ws://{}:{}{}",
                ws_cfg.host,
                ws_cfg.port,
                ws_cfg.path
            );
            if let Err(e) =
        hmi_io_server::ws::run_server(&ws_cfg, bc_ws, reg_ws, pm_ws, mon_ws, Some(alarm_ws)).await
            {
                log::error!("WS fatal: {}", e);
            }
        });

        // Spawn Web UI (non-critical - detach, errors are self-logged)
        let web_port_clone = web_port;
        let web_monitor = monitor.clone();
        let reg_web = registry.clone();
        let redundancy_web = redundancy.clone();
        let pm_web = point_manager.clone();
        let alarm_web = alarm_engine.clone();
        tokio::spawn(async move {
            log::info!("Web UI starting on port {}...", web_port_clone);
            match hmi_io_web::server::run_web_server(
                repo_arc,
                web_monitor,
                reg_web,
                bc_web,
                pm_web,
                redundancy_web,
                alarm_web,
                auth,
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
            _ = role_task => {}
            _ = engine_task => {}
            r = ws_h => {
                log::error!("WS server exited unexpectedly: {:?}", r);
                log::info!("Shutting down...");
            }
        }
        registry.shutdown();
        persister.abort();
        log::info!("=== Shutdown complete ===");
        Ok::<(), anyhow::Error>(())
    })?;
    Ok(())
}

async fn build_config(repo: &Repo, yaml_path: &str) -> anyhow::Result<AppConfig> {
    if let Ok(plugins) = repo.list_plugins().await {
        if !plugins.is_empty() {
            log::info!("Loading config from database");
            let cfg = AppConfig::from_repo(repo).await;
            cfg.validate()?;
            return Ok(cfg);
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
    app_config.validate()?;
    migrate_yaml_to_db(repo, &app_config).await;
    Ok(app_config)
}

async fn migrate_yaml_to_db(repo: &Repo, config: &AppConfig) {
    log::info!("Migrating YAML to DB...");
    let _ = repo
        .set_config(
            "scan_interval_ms",
            &config.plugins.scan_interval_ms.to_string(),
        )
        .await;
    let _ = repo
        .set_config(
            "batch_interval_ms",
            &config.server.batch_interval_ms.to_string(),
        )
        .await;
    let _ = repo
        .set_config("plugin_dir", &config.plugins.directory)
        .await;
    let _ = repo.set_config("ws_host", &config.server.host).await;
    let _ = repo
        .set_config("ws_port", &config.server.port.to_string())
        .await;
    let _ = repo
        .set_config("web_port", &config.server.web_port.to_string())
        .await;
    let _ = repo
        .set_config("project_dir", &config.server.project_dir)
        .await;
    let _ = repo
        .set_config(
            "redundancy_config",
            &serde_json::to_string(&config.redundancy).unwrap_or_else(|_| "{}".into()),
        )
        .await;
    let _ = repo
        .set_config(
            "alarm_retention_days",
            &config.alarm.retention_alarm_days.to_string(),
        )
        .await;
    let _ = repo
        .set_config(
            "soe_retention_days",
            &config.alarm.retention_soe_days.to_string(),
        )
        .await;
    for rule in &config.alarm.rules {
        let row = hmi_io_db::repo::AlarmRuleRow {
            id: rule.id.clone(),
            variable_id: rule.variable_id.clone(),
            name: rule.name.clone(),
            description: rule.description.clone(),
            severity: rule.severity.clone(),
            group_name: rule.group.clone(),
            condition: rule.condition.clone(),
            threshold: rule.threshold,
            enabled: rule.enabled,
            hysteresis: rule.hysteresis,
            confirm_ms: rule.confirm_ms,
        };
        if let Err(e) = repo.insert_alarm_rule(&row).await {
            log::warn!("  Skip alarm rule '{}': {}", rule.id, e);
        } else {
            log::info!("  Migrated alarm rule '{}'", rule.id);
        }
    }
    for inst in &config.plugins.instances {
        let cj = serde_json::to_string(&inst.config).unwrap_or_else(|_| "{}".into());
        match repo
            .insert_plugin_full(
                &inst.name,
                &inst.wasm_file,
                &cj,
                &inst.redundancy_group,
                &inst.redundancy_role,
                inst.priority,
            )
            .await
        {
            Ok(pid) => {
                for pt in &inst.points {
                    let _ = repo
                        .insert_point(
                            pid,
                            &pt.id,
                            &pt.address,
                            &pt.data_type,
                            &pt.byte_order,
                            pt.scale,
                            pt.offset,
                            &pt.var_type,
                            "",
                        )
                        .await;
                }
                log::info!("  Migrated '{}': {} points", inst.name, inst.points.len());
            }
            Err(e) => log::warn!("  Skip '{}': {}", inst.name, e),
        }
    }
}
