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
    name: String,
    cmd_tx: mpsc::UnboundedSender<PluginCommand>,
    abort_handle: tokio::task::AbortHandle,
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
        let mut plugin =
            self.host
                .load_plugin(&wasm_path_str, point_tx, monitor.clone(), &plugin_name)?;

        let init_ok = plugin.init(&config_json)?;
        if init_ok != 0 {
            anyhow::bail!("plugin_init returned: {}", init_ok);
        }

        let conn_ok = plugin.connect()?;
        if conn_ok != 0 {
            log::warn!("plugin_connect returned: {} (continuing)", conn_ok);
        }

        let status_code = plugin.get_status()?;
        log::info!(
            "Plugin '{}' connected, status: {}",
            plugin_name,
            status_code
        );
        monitor.set_connection_state(&plugin_name, status_code);

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let scan_dur = Duration::from_millis(scan_interval_ms);
        let actor_name = plugin_name.clone();
        let mon = monitor.clone();

        let handle = tokio::task::spawn_blocking(move || {
            run_plugin_actor(actor_name, plugin, cmd_rx, scan_dur, mon);
        });

        self.plugins.lock().unwrap().insert(
            plugin_name,
            PluginHandle {
                name: inst_cfg.name.clone(),
                cmd_tx,
                abort_handle: handle.abort_handle(),
            },
        );
        Ok(())
    }

    pub async fn reload_plugin(&self, plugin_name: &str) -> anyhow::Result<()> {
        {
            let mut plugins = self.plugins.lock().unwrap();
            if let Some(handle) = plugins.remove(plugin_name) {
                let _ = handle.cmd_tx.send(PluginCommand::Shutdown);
                handle.abort_handle.abort();
                log::info!("Plugin '{}' shut down for reload", plugin_name);
            }
        }

        let config = self.config_cache.lock().unwrap();
        if let Some(ref cfg) = *config {
            if let Some(inst) = cfg.plugins.instances.iter().find(|i| i.name == plugin_name) {
                self.load_and_start(inst, cfg.plugins.scan_interval_ms)
                    .await?;
                log::info!("Plugin '{}' reloaded successfully", plugin_name);
                return Ok(());
            }
        }
        anyhow::bail!("Plugin '{}' not found in config", plugin_name)
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

fn run_plugin_actor(
    name: String,
    mut plugin: PluginInstance,
    cmd_rx: mpsc::UnboundedReceiver<PluginCommand>,
    scan_interval: Duration,
    monitor: Arc<MonitorCollector>,
) {
    let mut cmd_rx = cmd_rx;
    let mut next_scan = std::time::Instant::now();

    loop {
        let now = std::time::Instant::now();
        if now >= next_scan {
            match plugin.scan_points() {
                Ok(0) => {
                    monitor.record_scan(&name);
                    if let Ok(s) = plugin.get_status() {
                        monitor.set_connection_state(&name, s);
                    }
                }
                Ok(code) => {
                    monitor.record_error(&name, &format!("scan_points returned code {}", code));
                    log::warn!("[{}] scan_points: {}", name, code);
                }
                Err(e) => {
                    monitor.record_error(&name, &e.to_string());
                    log::error!("[{}] scan_points error: {}", name, e);
                }
            }
            next_scan = now + scan_interval;
        }

        match cmd_rx.try_recv() {
            Ok(PluginCommand::WritePoint {
                name: pt,
                value,
                reply,
            }) => {
                let r = match plugin.write_point(&pt, value) {
                    Ok(0) => Ok(()),
                    Ok(c) => Err(format!("code:{}", c)),
                    Err(e) => Err(e.to_string()),
                };
                let _ = reply.send(r);
            }
            Ok(PluginCommand::GetStatus { reply }) => {
                let s = plugin.get_status().unwrap_or(-1);
                monitor.set_connection_state(&name, s);
                let _ = reply.send(s);
            }
            Ok(PluginCommand::Shutdown) => {
                let _ = plugin.disconnect();
                monitor.set_connection_state(&name, 0);
                break;
            }
            Err(mpsc::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
    log::info!("Plugin '{}' actor stopped", name);
}
