//! Plugin Registry
//!
//! Manages plugin lifecycle: loading, starting actor loops,
//! handling write commands, hot-reload, and monitoring.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use super::host::PluginHost;
use super::interface::PluginInstance;
use crate::config::{AppConfig, PluginInstance as PluginInstanceConfig};
use crate::monitor::collector::MonitorCollector;
use crate::point::types::PointValue;

/// Minimum time between automatic reconnect attempts after a link loss.
const RECONNECT_MIN_INTERVAL: Duration = Duration::from_secs(5);

// ── Commands sent to plugin actor ──────────────────────────

enum PluginCommand {
    WritePoint {
        name: String,
        value: f64,
        reply: oneshot::Sender<Result<(), String>>,
    },
    GetStatus {
        reply: oneshot::Sender<i32>,
    },
    Shutdown,
}

// ── Handle to a running plugin actor ───────────────────────

struct PluginHandle {
    cmd_tx: mpsc::UnboundedSender<PluginCommand>,
}

// ── PluginRegistry ─────────────────────────────────────────

pub struct PluginRegistry {
    host: PluginHost,
    plugins: Mutex<HashMap<String, PluginHandle>>,
    plugin_dir: Mutex<PathBuf>,
    point_tx: mpsc::UnboundedSender<PointValue>,
    point_rx: Mutex<Option<mpsc::UnboundedReceiver<PointValue>>>,
    monitor: Arc<MonitorCollector>,
    config_cache: Mutex<Option<AppConfig>>,
}

impl PluginRegistry {
    pub fn new(monitor: Arc<MonitorCollector>) -> anyhow::Result<Self> {
        let host = PluginHost::new()?;
        let (point_tx, point_rx) = mpsc::unbounded_channel();
        Ok(Self {
            host,
            plugins: Mutex::new(HashMap::new()),
            plugin_dir: Mutex::new(PathBuf::from("./plugins")),
            point_tx,
            point_rx: Mutex::new(Some(point_rx)),
            monitor,
            config_cache: Mutex::new(None),
        })
    }

    pub async fn init_from_config(&self, config: &AppConfig) -> anyhow::Result<()> {
        {
            let mut pdir = self.plugin_dir.lock().unwrap();
            *pdir = PathBuf::from(&config.plugins.directory);
            if pdir.is_relative() {
                if let Ok(cwd) = std::env::current_dir() {
                    *pdir = cwd.join(&*pdir);
                }
            }
            log::info!("Plugin directory: {}", pdir.display());
        }

        *self.config_cache.lock().unwrap() = Some(config.clone());

        for inst in &config.plugins.instances {
            match self
                .load_and_start(inst, config.plugins.scan_interval_ms)
                .await
            {
                Ok(()) => log::info!("Loaded plugin: {}", inst.name),
                Err(e) => log::error!("Failed to load plugin '{}': {}", inst.name, e),
            }
        }
        Ok(())
    }

    async fn load_and_start(
        &self,
        inst_cfg: &PluginInstanceConfig,
        scan_interval_ms: u64,
    ) -> anyhow::Result<()> {
        let plugin_dir = self.plugin_dir.lock().unwrap().clone();
        let wasm_path = if PathBuf::from(&inst_cfg.wasm_file).is_absolute() {
            PathBuf::from(&inst_cfg.wasm_file)
        } else {
            plugin_dir.join(&inst_cfg.wasm_file)
        };

        if !wasm_path.exists() {
            anyhow::bail!("WASM file not found: {}", wasm_path.display());
        }

        let mut full_config = inst_cfg.config.clone();
        let points_array: Vec<serde_json::Value> = inst_cfg
            .points
            .iter()
            .map(|pt| {
                serde_json::json!({
                    "variable_id": pt.id,
                    "address": pt.address,
                    "var_type": pt.var_type,
                    "data_type": pt.data_type,
                    "byte_order": pt.byte_order,
                    "scale": pt.scale,
                    "offset": pt.offset
                })
            })
            .collect();
        full_config["points"] = serde_json::Value::Array(points_array);
        let config_json = serde_json::to_string(&full_config)?;

        let plugin_name = inst_cfg.name.clone();
        let point_tx = self.point_tx.clone();
        let monitor = self.monitor.clone();

        let point_configs: Vec<(String, String, String, String, f64, f64, String)> = inst_cfg
            .points
            .iter()
            .map(|pt| {
                (
                    pt.id.clone(),
                    pt.address.clone(),
                    pt.var_type.clone(),
                    pt.data_type.clone(),
                    pt.scale,
                    pt.offset,
                    pt.byte_order.clone(),
                )
            })
            .collect();
        monitor.register_plugin(&plugin_name, &inst_cfg.wasm_file, &point_configs);

        let wasm_path_str = wasm_path.to_string_lossy().to_string();
        let mut plugin = self
            .host
            .load_plugin(&wasm_path_str, point_tx, monitor.clone(), &plugin_name)
            .await?;

        let init_ok = plugin.init(&config_json).await?;
        if init_ok != 0 {
            anyhow::bail!("plugin_init returned: {}", init_ok);
        }

        let conn_ok = plugin.connect().await?;
        if conn_ok != 0 {
            log::warn!("plugin_connect returned: {} (continuing)", conn_ok);
        }

        let status_code = plugin.get_status().await?;
        log::info!(
            "Plugin '{}' connected, status: {}",
            plugin_name,
            status_code
        );
        monitor.set_connection_state(&plugin_name, status_code as i32);

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let scan_dur = Duration::from_millis(scan_interval_ms);
        let actor_name = plugin_name.clone();
        let mon = monitor.clone();

        let handle = tokio::task::spawn(async move {
            run_plugin_actor(actor_name, plugin, cmd_rx, scan_dur, mon).await;
        });
        let _ = handle;

        self.plugins.lock().unwrap().insert(
            plugin_name,
            PluginHandle { cmd_tx },
        );
        Ok(())
    }

    pub async fn write_point(&self, point_name: &str, value: f64) -> anyhow::Result<()> {
        // Collect sender + receiver pairs first, then await
        let pairs: Vec<(String, oneshot::Receiver<Result<(), String>>)> = {
            let plugins = self.plugins.lock().unwrap();
            plugins
                .iter()
                .filter_map(|(pn, h)| {
                    let (tx, rx) = oneshot::channel();
                    if h.cmd_tx
                        .send(PluginCommand::WritePoint {
                            name: point_name.to_string(),
                            value,
                            reply: tx,
                        })
                        .is_ok()
                    {
                        Some((pn.clone(), rx))
                    } else {
                        None
                    }
                })
                .collect()
        };

        for (pn, rx) in pairs {
            if let Ok(result) = rx.await {
                match result {
                    Ok(()) => {
                        log::debug!("Wrote '{}' via '{}'", point_name, pn);
                        return Ok(());
                    }
                    Err(e) => log::debug!("'{}' rejected: {}", pn, e),
                }
            }
        }
        anyhow::bail!("point '{}' not found in any plugin", point_name)
    }

    pub async fn plugin_statuses(&self) -> Vec<(String, String)> {
        let pairs: Vec<(String, oneshot::Receiver<i32>)> = {
            let plugins = self.plugins.lock().unwrap();
            plugins
                .iter()
                .filter_map(|(pn, h)| {
                    let (tx, rx) = oneshot::channel();
                    if h.cmd_tx
                        .send(PluginCommand::GetStatus { reply: tx })
                        .is_ok()
                    {
                        Some((pn.clone(), rx))
                    } else {
                        None
                    }
                })
                .collect()
        };

        let mut r = Vec::new();
        for (name, rx) in pairs {
            if let Ok(code) = rx.await {
                let s = match code {
                    0 => "disconnected",
                    1 => "connecting",
                    2 => "connected",
                    3 => "error",
                    _ => "unknown",
                };
                r.push((name, s.to_string()));
            }
        }
        r
    }

    pub fn take_point_receiver(&self) -> Option<mpsc::UnboundedReceiver<PointValue>> {
        self.point_rx.lock().unwrap().take()
    }

    pub fn shutdown(&self) {
        let mut plugins = self.plugins.lock().unwrap();
        for h in plugins.values() {
            let _ = h.cmd_tx.send(PluginCommand::Shutdown);
        }
        plugins.clear();
    }
}

// ── Plugin Actor Loop ──────────────────────────────────────

async fn run_plugin_actor(
    name: String,
    mut plugin: PluginInstance,
    mut cmd_rx: mpsc::UnboundedReceiver<PluginCommand>,
    scan_interval: Duration,
    monitor: Arc<MonitorCollector>,
) {
    let mut interval = tokio::time::interval(scan_interval);
    let mut last_reconnect = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = interval.tick() => {
                match plugin.scan_points().await {
                    Ok(0) => {
                        monitor.record_scan(&name);
                        if let Ok(s) = plugin.get_status().await {
                            monitor.set_connection_state(&name, s as i32);
                        }
                    }
                    Ok(code) => {
                        monitor.record_error(&name, &format!("scan_points returned code {}", code));
                        log::warn!("[{}] scan_points: {}", name, code);
                        let connected = plugin.get_status().await.unwrap_or(0) == 2;
                        if !connected && last_reconnect.elapsed() >= RECONNECT_MIN_INTERVAL {
                            last_reconnect = std::time::Instant::now();
                            log::info!("[{}] link lost, attempting reconnect...", name);
                            match plugin.connect().await {
                                Ok(0) => {
                                    monitor.set_connection_state(&name, 2);
                                    log::info!("[{}] reconnected", name);
                                }
                                Ok(r) => {
                                    monitor.record_error(&name, &format!("reconnect failed code {}", r));
                                    log::warn!("[{}] reconnect failed: {}", name, r);
                                }
                                Err(e) => {
                                    monitor.record_error(&name, &format!("reconnect error: {}", e));
                                    log::warn!("[{}] reconnect error: {}", name, e);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        monitor.record_error(&name, &e.to_string());
                        log::error!("[{}] scan_points error: {}", name, e);
                    }
                }
            }
            cmd = cmd_rx.recv() => match cmd {
                Some(PluginCommand::WritePoint {
                    name: pt,
                    value,
                    reply,
                }) => {
                    let r = match plugin.write_point(&pt, value).await {
                        Ok(0) => Ok(()),
                        Ok(c) => Err(format!("code:{}", c)),
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = reply.send(r);
                }
                Some(PluginCommand::GetStatus { reply }) => {
                    let s = plugin.get_status().await.unwrap_or(u32::MAX) as i32;
                    monitor.set_connection_state(&name, s);
                    let _ = reply.send(s);
                }
                Some(PluginCommand::Shutdown) => {
                    let _ = plugin.disconnect().await;
                    monitor.set_connection_state(&name, 0);
                    break;
                }
                None => break,
            },
        }
    }
    log::info!("Plugin '{}' actor stopped", name);
}
