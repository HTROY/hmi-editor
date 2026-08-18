//! Plugin Registry
//!
//! Manages plugin lifecycle: loading, starting actor loops,
//! handling write commands, hot-reload, and monitoring.
//!
//! Implementation is split by responsibility:
//! - [`self::actor`]: plugin actor loop plumbing (`PluginCommand`,
//!   `PluginHandle`, `run_plugin_actor`).
//! - [`self::groups`]: instance-level redundancy group state, supervision
//!   loop and switch decisions (`rebuild_groups`, `supervise_groups`,
//!   `switch_group`, ...).

mod actor;
mod groups;

pub use groups::InstanceGroupStatus;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use sync_util::MutexExt;

use tokio::sync::mpsc;

use super::host::PluginHost;
use hmi_io_config::{AppConfig, PluginInstance as PluginInstanceConfig};
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_point::manager::PointManager;
use hmi_io_point::types::PointValue;

pub struct PluginRegistry {
    host: PluginHost,
    plugins: Mutex<HashMap<String, actor::PluginHandle>>,
    plugin_dir: Mutex<PathBuf>,
    point_tx: mpsc::UnboundedSender<PointValue>,
    point_rx: Mutex<Option<mpsc::UnboundedReceiver<PointValue>>>,
    monitor: Arc<MonitorCollector>,
    config_cache: Mutex<Option<AppConfig>>,
    groups: Mutex<HashMap<String, groups::GroupStateInner>>,
    instance_redundancy: Mutex<hmi_io_config::RedundancyConfig>,
    point_manager: Mutex<Option<Arc<Mutex<PointManager>>>>,
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
            groups: Mutex::new(HashMap::new()),
            instance_redundancy: Mutex::new(Default::default()),
            point_manager: Mutex::new(None),
        })
    }

    pub async fn init_from_config(&self, config: &AppConfig) -> anyhow::Result<()> {
        self.prepare(config).await?;
        self.start_instances(config).await
    }

    /// 记录插件目录与配置缓存，不启动任何插件（Standby 节点使用）。
    pub async fn prepare(&self, config: &AppConfig) -> anyhow::Result<()> {
        {
            let mut pdir = self.plugin_dir.lock_recover();
            *pdir = PathBuf::from(&config.plugins.directory);
            if pdir.is_relative() {
                if let Ok(cwd) = std::env::current_dir() {
                    *pdir = cwd.join(&*pdir);
                }
            }
            log::info!("Plugin directory: {}", pdir.display());
        }

        *self.config_cache.lock_recover() = Some(config.clone());
        *self.instance_redundancy.lock_recover() = config.redundancy.clone();
        self.rebuild_groups(config);
        Ok(())
    }

    /// 启动全部已配置插件实例（Active 节点/升主时调用）；已有插件运行则跳过。
    pub async fn start_instances(&self, config: &AppConfig) -> anyhow::Result<()> {
        if !self.plugins.lock_recover().is_empty() {
            return Ok(());
        }
        self.rebuild_groups(config);
        let start_list: Vec<&PluginInstanceConfig> = {
            let groups = self.groups.lock_recover();
            config
                .plugins
                .instances
                .iter()
                .filter(|inst| {
                    inst.redundancy_group.is_empty()
                        || groups
                            .get(&inst.redundancy_group)
                            .map(|g| g.active == inst.name)
                            .unwrap_or(false)
                })
                .collect()
        };
        for inst in start_list {
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

    pub fn has_plugins(&self) -> bool {
        !self.plugins.lock_recover().is_empty()
    }

    pub fn set_point_manager(&self, pm: Arc<Mutex<PointManager>>) {
        *self.point_manager.lock_recover() = Some(pm);
    }

    async fn load_and_start(
        &self,
        inst_cfg: &PluginInstanceConfig,
        scan_interval_ms: u64,
    ) -> anyhow::Result<()> {
        let plugin_dir = self.plugin_dir.lock_recover().clone();
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
        let scan_dur = std::time::Duration::from_millis(scan_interval_ms);
        let actor_name = plugin_name.clone();
        let mon = monitor.clone();

        // 带 panic 边界：actor 循环 panic 时记录日志而不是静默消失
        let handle =
            sync_util::task::spawn_monitored(&format!("plugin-actor:{actor_name}"), async move {
                actor::run_plugin_actor(actor_name, plugin, cmd_rx, scan_dur, mon).await;
            });
        let _ = handle;

        self.plugins
            .lock()
            .unwrap()
            .insert(plugin_name, actor::PluginHandle { cmd_tx });
        Ok(())
    }

    pub async fn write_point(&self, point_name: &str, value: f64) -> anyhow::Result<()> {
        let target = {
            let cache = self.config_cache.lock_recover();
            let groups = self.groups.lock_recover();
            cache
                .as_ref()
                .and_then(|cfg| groups::resolve_write_target(cfg, &groups, point_name))
        };
        let Some((plugin_name, variable_id)) = target else {
            anyhow::bail!("point '{}' not found in any plugin instance", point_name);
        };

        let cmd_tx = {
            let plugins = self.plugins.lock_recover();
            plugins.get(&plugin_name).map(|h| h.cmd_tx.clone())
        };
        let Some(cmd_tx) = cmd_tx else {
            anyhow::bail!("plugin instance '{}' is not running", plugin_name);
        };

        let (tx, rx) = tokio::sync::oneshot::channel();
        cmd_tx
            .send(actor::PluginCommand::WritePoint {
                name: variable_id,
                value,
                reply: tx,
            })
            .map_err(|_| anyhow::anyhow!("plugin '{}' is not accepting commands", plugin_name))?;

        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => anyhow::bail!("plugin '{}' rejected write: {}", plugin_name, e),
            Err(e) => anyhow::bail!("plugin '{}' write failed: {}", plugin_name, e),
        }
    }

    pub async fn plugin_statuses(&self) -> Vec<(String, String)> {
        let pairs: Vec<(String, tokio::sync::oneshot::Receiver<i32>)> = {
            let plugins = self.plugins.lock_recover();
            plugins
                .iter()
                .filter_map(|(pn, h)| {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    if h.cmd_tx
                        .send(actor::PluginCommand::GetStatus { reply: tx })
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
        self.point_rx.lock_recover().take()
    }

    pub fn shutdown(&self) {
        let mut plugins = self.plugins.lock_recover();
        for h in plugins.values() {
            let _ = h.cmd_tx.send(actor::PluginCommand::Shutdown);
        }
        plugins.clear();
    }
}
