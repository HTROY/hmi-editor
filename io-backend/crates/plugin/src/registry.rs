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
use hmi_io_config::{AppConfig, PluginInstance as PluginInstanceConfig};
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_point::manager::PointManager;
use hmi_io_point::{point_key, types::PointValue};
use serde::Serialize;

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

#[derive(Debug, Clone, Serialize)]
pub struct InstanceGroupStatus {
    pub group: String,
    pub members: Vec<InstanceMemberStatus>,
    pub active_instance: String,
    pub consecutive_failures: u32,
    pub last_switch_ms: u64,
    pub last_switch_reason: String,
    pub switch_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceMemberStatus {
    pub name: String,
    pub role: String,
    pub priority: u32,
    pub is_active: bool,
    pub connection_state: i32,
    pub connection_label: String,
}

#[derive(Debug, Clone)]
struct MemberRef {
    name: String,
    role: String,
    priority: u32,
}

#[derive(Debug, Clone)]
struct GroupStateInner {
    group: String,
    members: Vec<MemberRef>,
    active: String,
    failures: u32,
    probe_ticks: u32,
    last_switch_ms: u64,
    last_switch_reason: String,
    switch_count: u64,
}

fn next_member(members: &[MemberRef], active: &str) -> Option<String> {
    let idx = members.iter().position(|m| m.name == active)?;
    Some(members[(idx + 1) % members.len()].name.clone())
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
    groups: Mutex<HashMap<String, GroupStateInner>>,
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
        *self.instance_redundancy.lock().unwrap() = config.redundancy.clone();
        self.rebuild_groups(config);
        Ok(())
    }

    fn rebuild_groups(&self, config: &AppConfig) {
        let mut raw: HashMap<String, Vec<&PluginInstanceConfig>> = HashMap::new();
        for inst in &config.plugins.instances {
            if inst.redundancy_group.is_empty() {
                continue;
            }
            raw.entry(inst.redundancy_group.clone())
                .or_default()
                .push(inst);
        }
        let mut inner_map = HashMap::new();
        for (group, mut members) in raw {
            members.sort_by_key(|m| match m.redundancy_role.as_str() {
                "primary" => (0, 0),
                _ => (1, m.priority),
            });
            let member_refs: Vec<MemberRef> = members
                .iter()
                .map(|m| MemberRef {
                    name: m.name.clone(),
                    role: m.redundancy_role.clone(),
                    priority: m.priority,
                })
                .collect();
            let active = members
                .iter()
                .find(|m| m.redundancy_role == "primary")
                .map(|m| m.name.clone())
                .unwrap_or_default();
            inner_map.insert(
                group.clone(),
                GroupStateInner {
                    group,
                    members: member_refs,
                    active,
                    failures: 0,
                    probe_ticks: 0,
                    last_switch_ms: 0,
                    last_switch_reason: String::new(),
                    switch_count: 0,
                },
            );
        }
        *self.groups.lock().unwrap() = inner_map;
    }

    /// 启动全部已配置插件实例（Active 节点/升主时调用）；已有插件运行则跳过。
    pub async fn start_instances(&self, config: &AppConfig) -> anyhow::Result<()> {
        if !self.plugins.lock().unwrap().is_empty() {
            return Ok(());
        }
        self.rebuild_groups(config);
        let start_list: Vec<&PluginInstanceConfig> = {
            let groups = self.groups.lock().unwrap();
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
        !self.plugins.lock().unwrap().is_empty()
    }

    pub fn set_point_manager(&self, pm: Arc<Mutex<PointManager>>) {
        *self.point_manager.lock().unwrap() = Some(pm);
    }

    pub fn instance_groups_status(&self) -> Vec<InstanceGroupStatus> {
        let snap = self.monitor.get_snapshot();
        let statuses: HashMap<&str, &hmi_io_monitor::types::PluginStatus> = snap
            .plugins
            .iter()
            .map(|p| (p.name.as_str(), p))
            .collect();
        let groups = self.groups.lock().unwrap();
        let mut out = Vec::new();
        for g in groups.values() {
            let members = g
                .members
                .iter()
                .map(|m| {
                    let s = statuses.get(m.name.as_str());
                    InstanceMemberStatus {
                        name: m.name.clone(),
                        role: m.role.clone(),
                        priority: m.priority,
                        is_active: m.name == g.active,
                        connection_state: s.map(|p| p.connection_state).unwrap_or(0),
                        connection_label: s
                            .map(|p| p.connection_label.clone())
                            .unwrap_or_else(|| "disconnected".into()),
                    }
                })
                .collect();
            out.push(InstanceGroupStatus {
                group: g.group.clone(),
                members,
                active_instance: g.active.clone(),
                consecutive_failures: g.failures,
                last_switch_ms: g.last_switch_ms,
                last_switch_reason: g.last_switch_reason.clone(),
                switch_count: g.switch_count,
            });
        }
        out
    }

    pub fn spawn_instance_supervisor(
        self: &Arc<Self>,
        scan_interval_ms: u64,
    ) -> Option<tokio::task::JoinHandle<()>> {
        if self.groups.lock().unwrap().is_empty() {
            return None;
        }
        let this = self.clone();
        Some(tokio::spawn(async move {
            let dur = Duration::from_millis(scan_interval_ms.max(100));
            let mut tick = tokio::time::interval(dur);
            loop {
                tick.tick().await;
                this.supervise_groups(scan_interval_ms).await;
            }
        }))
    }

    async fn supervise_groups(&self, scan_interval_ms: u64) {
        let Some(config) = self.config_cache.lock().unwrap().clone() else {
            return;
        };
        let settings = self.instance_redundancy.lock().unwrap().clone();
        let snap = self.monitor.get_snapshot();
        let statuses: HashMap<&str, &hmi_io_monitor::types::PluginStatus> = snap
            .plugins
            .iter()
            .map(|p| (p.name.as_str(), p))
            .collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let threshold = settings.instance_failover_threshold.max(1);
        let cooldown = settings.instance_switch_cooldown_ms;
        let fresh_window = scan_interval_ms.max(100) * 3;

        // 1) 活跃成员健康检查与切换
        let mut switch_ops: Vec<(String, String, String)> = Vec::new();
        {
            let mut groups = self.groups.lock().unwrap();
            for g in groups.values_mut() {
                let active = g.active.clone();
                let healthy = statuses
                    .get(active.as_str())
                    .map(|s| {
                        s.connection_state == 2
                            && snap.server_uptime_ms.saturating_sub(s.last_scan_time_ms)
                                < fresh_window
                    })
                    .unwrap_or(false);
                if healthy {
                    g.failures = 0;
                    continue;
                }
                g.failures += 1;
                if g.failures < threshold || now.saturating_sub(g.last_switch_ms) < cooldown {
                    continue;
                }
                if let Some(next) = next_member(&g.members, &active) {
                    if next != active {
                        switch_ops.push((g.group.clone(), next, "active instance unhealthy".into()));
                    }
                }
            }
        }
        for (group, next, reason) in switch_ops {
            self.switch_group(&config, &group, &next, &reason, scan_interval_ms)
                .await;
        }

        // 2) 回切探测
        if settings.instance_failback_enabled {
            let failback_interval = settings.instance_failback_delay_ms.max(scan_interval_ms.max(100));
            let mut probe_ops: Vec<(String, String)> = Vec::new();
            {
                let mut groups = self.groups.lock().unwrap();
                for g in groups.values_mut() {
                    let Some(primary) = g.members.first().map(|m| m.name.clone()) else {
                        continue;
                    };
                    if g.active != primary {
                        g.probe_ticks += 1;
                        if (g.probe_ticks as u64) * scan_interval_ms.max(100) >= failback_interval {
                            g.probe_ticks = 0;
                            probe_ops.push((g.group.clone(), primary));
                        }
                    }
                }
            }
            for (group, primary) in probe_ops {
                self.probe_primary_and_takeover(&config, &group, &primary, scan_interval_ms)
                    .await;
            }
        }
    }

    async fn switch_group(
        &self,
        config: &AppConfig,
        group: &str,
        next: &str,
        reason: &str,
        scan_interval_ms: u64,
    ) {
        let old = {
            self.groups
                .lock()
                .unwrap()
                .get(group)
                .map(|g| g.active.clone())
        };
        let Some(old) = old else { return };
        if old == next {
            return;
        }
        self.shutdown_instance(&old).await;
        if let Some(inst) = config
            .plugins
            .instances
            .iter()
            .find(|i| i.name == next)
            .cloned()
        {
            match self.load_and_start(&inst, scan_interval_ms).await {
                Ok(()) => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    {
                        let mut groups = self.groups.lock().unwrap();
                        if let Some(g) = groups.get_mut(group) {
                            g.active = next.to_string();
                            g.failures = 0;
                            g.last_switch_ms = now;
                            g.last_switch_reason = reason.to_string();
                            g.switch_count += 1;
                        }
                    }
                    if let Some(pm) = self.point_manager.lock().unwrap().as_ref() {
                        pm.lock().unwrap().set_active_instance(group, next);
                    }
                    log::warn!(
                        "Instance group '{}': switched {} -> {} ({})",
                        group,
                        old,
                        next,
                        reason
                    );
                }
                Err(e) => log::error!(
                    "Instance group '{}': failed to start '{}': {}",
                    group,
                    next,
                    e
                ),
            }
        }
    }

    async fn shutdown_instance(&self, name: &str) {
        let cmd = {
            self.plugins
                .lock()
                .unwrap()
                .get(name)
                .map(|h| h.cmd_tx.clone())
        };
        if let Some(tx) = cmd {
            let _ = tx.send(PluginCommand::Shutdown);
        }
        self.plugins.lock().unwrap().remove(name);
    }

    async fn probe_primary_and_takeover(
        &self,
        config: &AppConfig,
        group: &str,
        primary: &str,
        scan_interval_ms: u64,
    ) {
        if self.plugins.lock().unwrap().contains_key(primary) {
            return;
        }
        let Some(inst) = config
            .plugins
            .instances
            .iter()
            .find(|i| i.name == primary)
            .cloned()
        else {
            return;
        };
        if let Err(e) = self.load_and_start(&inst, scan_interval_ms).await {
            log::warn!("Instance group '{}': primary probe failed: {}", group, e);
            return;
        }
        let connected = self
            .monitor
            .get_plugin_status(primary)
            .map(|s| s.connection_state == 2)
            .unwrap_or(false);
        if connected {
            let backup = {
                self.groups
                    .lock()
                    .unwrap()
                    .get(group)
                    .map(|g| g.active.clone())
            };
            if let Some(backup) = backup {
                if backup != primary {
                    self.shutdown_instance(&backup).await;
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    {
                        let mut groups = self.groups.lock().unwrap();
                        if let Some(g) = groups.get_mut(group) {
                            g.active = primary.to_string();
                            g.failures = 0;
                            g.probe_ticks = 0;
                            g.last_switch_ms = now;
                            g.last_switch_reason = "primary recovered".into();
                            g.switch_count += 1;
                        }
                    }
                    if let Some(pm) = self.point_manager.lock().unwrap().as_ref() {
                        pm.lock().unwrap().set_active_instance(group, primary);
                    }
                    log::info!("Instance group '{}': failback to '{}'", group, primary);
                }
            }
        } else {
            // 探测失败：立即关闭探测实例，避免与活跃备份双跑
            self.shutdown_instance(primary).await;
            log::warn!(
                "Instance group '{}': primary probe not connected, probe shut down",
                group
            );
        }
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
        let target = {
            let cache = self.config_cache.lock().unwrap();
            let groups = self.groups.lock().unwrap();
            cache
                .as_ref()
                .and_then(|cfg| resolve_write_target(cfg, &groups, point_name))
        };
        let Some((plugin_name, variable_id)) = target else {
            anyhow::bail!("point '{}' not found in any plugin instance", point_name);
        };

        let cmd_tx = {
            let plugins = self.plugins.lock().unwrap();
            plugins.get(&plugin_name).map(|h| h.cmd_tx.clone())
        };
        let Some(cmd_tx) = cmd_tx else {
            anyhow::bail!("plugin instance '{}' is not running", plugin_name);
        };

        let (tx, rx) = oneshot::channel();
        cmd_tx
            .send(PluginCommand::WritePoint {
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

fn resolve_write_target(
    config: &AppConfig,
    groups: &HashMap<String, GroupStateInner>,
    point_name: &str,
) -> Option<(String, String)> {
    config.plugins.instances.iter().find_map(|inst| {
        inst.points.iter().find_map(|pt| {
            let logical = if inst.redundancy_group.is_empty() {
                point_key(&inst.name, &pt.id)
            } else {
                point_key(&inst.redundancy_group, &pt.id)
            };
            if logical != point_name {
                return None;
            }
            let target = if inst.redundancy_group.is_empty() {
                inst.name.clone()
            } else {
                groups
                    .get(&inst.redundancy_group)
                    .map(|g| g.active.clone())
                    .unwrap_or_else(|| inst.name.clone())
            };
            Some((target, pt.id.clone()))
        })
    })
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
                        let status = plugin.get_status().await.unwrap_or(0);
                        monitor.set_connection_state(&name, status as i32);
                        if status != 2 && last_reconnect.elapsed() >= RECONNECT_MIN_INTERVAL {
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
                                    let s = plugin.get_status().await.unwrap_or(0);
                                    monitor.set_connection_state(&name, s as i32);
                                }
                                Err(e) => {
                                    monitor.record_error(&name, &format!("reconnect error: {}", e));
                                    log::warn!("[{}] reconnect error: {}", name, e);
                                    monitor.set_connection_state(&name, 0);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        monitor.record_error(&name, &e.to_string());
                        log::error!("[{}] scan_points error: {}", name, e);
                        let s = plugin.get_status().await.unwrap_or(0);
                        monitor.set_connection_state(&name, s as i32);
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

#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_config::PointMapping;

    fn mapping(id: &str) -> PointMapping {
        PointMapping {
            id: id.into(),
            address: "coil:0".into(),
            data_type: "bool".into(),
            byte_order: "big_endian".into(),
            scale: 1.0,
            offset: 0.0,
            var_type: "DI".into(),
        }
    }

    fn config_with_two_instances() -> AppConfig {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
                redundancy_group: String::new(),
                redundancy_role: String::new(),
                priority: 0,
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1"), mapping("P2")],
                redundancy_group: String::new(),
                redundancy_role: String::new(),
                priority: 0,
            },
        ];
        cfg
    }

    #[test]
    fn resolve_write_target_routes_to_correct_instance() {
        let cfg = config_with_two_instances();
        let groups = HashMap::new();
        assert_eq!(
            resolve_write_target(&cfg, &groups, "mb1:P1"),
            Some(("mb1".to_string(), "P1".to_string()))
        );
        assert_eq!(
            resolve_write_target(&cfg, &groups, "mb2:P1"),
            Some(("mb2".to_string(), "P1".to_string()))
        );
        assert_eq!(
            resolve_write_target(&cfg, &groups, "mb2:P2"),
            Some(("mb2".to_string(), "P2".to_string()))
        );
    }

    #[test]
    fn resolve_write_target_unknown_returns_none() {
        let cfg = config_with_two_instances();
        let groups = HashMap::new();
        assert_eq!(resolve_write_target(&cfg, &groups, "mb1:P2"), None);
        assert_eq!(resolve_write_target(&cfg, &groups, "P1"), None);
    }

    #[test]
    fn next_member_follows_order_and_wraps() {
        let members = vec![
            MemberRef { name: "p".into(), role: "primary".into(), priority: 0 },
            MemberRef { name: "b1".into(), role: "backup".into(), priority: 1 },
            MemberRef { name: "b2".into(), role: "backup".into(), priority: 2 },
        ];
        assert_eq!(next_member(&members, "p"), Some("b1".to_string()));
        assert_eq!(next_member(&members, "b1"), Some("b2".to_string()));
        assert_eq!(next_member(&members, "b2"), Some("p".to_string()));
    }

    #[test]
    fn rebuild_groups_orders_primary_first_then_priority() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            PluginInstanceConfig {
                name: "b2".into(),
                wasm_file: "p.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
                redundancy_group: "mb-link".into(),
                redundancy_role: "backup".into(),
                priority: 2,
            },
            PluginInstanceConfig {
                name: "p".into(),
                wasm_file: "p.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
                redundancy_group: "mb-link".into(),
                redundancy_role: "primary".into(),
                priority: 0,
            },
            PluginInstanceConfig {
                name: "b1".into(),
                wasm_file: "p.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
                redundancy_group: "mb-link".into(),
                redundancy_role: "backup".into(),
                priority: 1,
            },
        ];
        let reg = PluginRegistry::new(MonitorCollector::new()).unwrap();
        reg.rebuild_groups(&cfg);
        let groups = reg.groups.lock().unwrap();
        let g = groups.get("mb-link").unwrap();
        let names: Vec<&str> = g.members.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["p", "b1", "b2"]);
        assert_eq!(g.active, "p");
    }

    #[test]
    fn resolve_write_target_routes_to_active_group_member() {
        let mut cfg = config_with_two_instances();
        cfg.plugins.instances[1].redundancy_group = "mb-link".into();
        cfg.plugins.instances[1].redundancy_role = "primary".into();
        cfg.plugins.instances.push(PluginInstanceConfig {
            name: "mb1b".into(),
            wasm_file: "modbus.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 1,
        });
        let mut groups = HashMap::new();
        groups.insert(
            "mb-link".into(),
            GroupStateInner {
                group: "mb-link".into(),
                members: vec![
                    MemberRef { name: "mb2".into(), role: "primary".into(), priority: 0 },
                    MemberRef { name: "mb1b".into(), role: "backup".into(), priority: 1 },
                ],
                active: "mb2".into(),
                failures: 0,
                probe_ticks: 0,
                last_switch_ms: 0,
                last_switch_reason: String::new(),
                switch_count: 0,
            },
        );
        assert_eq!(
            resolve_write_target(&cfg, &groups, "mb-link:P1"),
            Some(("mb2".to_string(), "P1".to_string()))
        );
    }
}
