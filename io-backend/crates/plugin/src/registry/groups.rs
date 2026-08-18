//! Instance-level redundancy groups: state types, group rebuild, and the
//! supervision/switch logic that keeps exactly one active member per group.
//!
//! Pure decision helpers (`evaluate_group`, `should_probe_primary`,
//! `should_reconnect`) live in [`crate::supervisor`]; this module
//! collects runtime inputs and executes the decided switches.

use std::collections::HashMap;
use sync_util::MutexExt;

use serde::Serialize;

use crate::supervisor::{
    evaluate_group, should_probe_primary, GroupHealth, MemberRef, SupervisionDecision,
};
use hmi_io_config::{AppConfig, PluginInstance as PluginInstanceConfig};
use hmi_io_point::logical_key;

use super::PluginRegistry;

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
pub(super) struct GroupStateInner {
    pub(super) group: String,
    pub(super) members: Vec<MemberRef>,
    pub(super) active: String,
    pub(super) failures: u32,
    pub(super) probe_ticks: u32,
    pub(super) last_switch_ms: u64,
    pub(super) last_switch_reason: String,
    pub(super) switch_count: u64,
}

impl PluginRegistry {
    pub(super) fn rebuild_groups(&self, config: &AppConfig) {
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
        *self.groups.lock_recover() = inner_map;
    }

    pub fn instance_groups_status(&self) -> Vec<InstanceGroupStatus> {
        let snap = self.monitor.get_snapshot();
        let statuses: HashMap<&str, &hmi_io_monitor::types::PluginStatus> =
            snap.plugins.iter().map(|p| (p.name.as_str(), p)).collect();
        let groups = self.groups.lock_recover();
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
        self: &std::sync::Arc<Self>,
        scan_interval_ms: u64,
    ) -> Option<tokio::task::JoinHandle<Option<()>>> {
        if self.groups.lock_recover().is_empty() {
            return None;
        }
        let this = self.clone();
        Some(sync_util::task::spawn_monitored(
            "instance-supervisor",
            async move {
                let dur = std::time::Duration::from_millis(scan_interval_ms.max(100));
                let mut tick = tokio::time::interval(dur);
                loop {
                    tick.tick().await;
                    this.supervise_groups(scan_interval_ms).await;
                }
            },
        ))
    }

    async fn supervise_groups(&self, scan_interval_ms: u64) {
        let Some(config) = self.config_cache.lock_recover().clone() else {
            return;
        };
        let settings = self.instance_redundancy.lock_recover().clone();
        let snap = self.monitor.get_snapshot();
        let statuses: HashMap<&str, &hmi_io_monitor::types::PluginStatus> =
            snap.plugins.iter().map(|p| (p.name.as_str(), p)).collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let threshold = settings.instance_failover_threshold.max(1);
        let cooldown = settings.instance_switch_cooldown_ms;
        let fresh_window = scan_interval_ms.max(100) * 3;

        // 1) 活跃成员健康检查与切换（决策逻辑在 supervisor::evaluate_group）
        let mut switch_ops: Vec<(String, String, String)> = Vec::new();
        {
            let mut groups = self.groups.lock_recover();
            for g in groups.values_mut() {
                let health = {
                    let active = g.active.clone();
                    let healthy = statuses
                        .get(active.as_str())
                        .map(|s| {
                            s.connection_state == 2
                                && snap.server_uptime_ms.saturating_sub(s.last_scan_time_ms)
                                    < fresh_window
                        })
                        .unwrap_or(false);
                    GroupHealth {
                        active,
                        failures: g.failures,
                        last_switch_ms: g.last_switch_ms,
                        active_healthy: healthy,
                        members: g.members.clone(),
                    }
                };
                match evaluate_group(&health, now, threshold, cooldown) {
                    SupervisionDecision::Healthy => g.failures = 0,
                    SupervisionDecision::KeepCounting => g.failures += 1,
                    SupervisionDecision::Switch { next } => {
                        switch_ops.push((g.group.clone(), next, "active instance unhealthy".into()))
                    }
                }
            }
        }
        for (group, next, reason) in switch_ops {
            self.switch_group(&config, &group, &next, &reason, scan_interval_ms)
                .await;
        }

        // 2) 回切探测（周期判定在 supervisor::should_probe_primary）
        if settings.instance_failback_enabled {
            let mut probe_ops: Vec<(String, String)> = Vec::new();
            {
                let mut groups = self.groups.lock_recover();
                for g in groups.values_mut() {
                    let Some(primary) = g.members.first().map(|m| m.name.clone()) else {
                        continue;
                    };
                    if g.active != primary {
                        g.probe_ticks += 1;
                        if should_probe_primary(
                            g.probe_ticks,
                            scan_interval_ms,
                            settings.instance_failback_delay_ms,
                        ) {
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
                        let mut groups = self.groups.lock_recover();
                        if let Some(g) = groups.get_mut(group) {
                            g.active = next.to_string();
                            g.failures = 0;
                            g.last_switch_ms = now;
                            g.last_switch_reason = reason.to_string();
                            g.switch_count += 1;
                        }
                    }
                    if let Some(pm) = self.point_manager.lock_recover().as_ref() {
                        pm.lock_recover().set_active_instance(group, next);
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
            let _ = tx.send(super::actor::PluginCommand::Shutdown);
        }
        self.plugins.lock_recover().remove(name);
    }

    async fn probe_primary_and_takeover(
        &self,
        config: &AppConfig,
        group: &str,
        primary: &str,
        scan_interval_ms: u64,
    ) {
        if self.plugins.lock_recover().contains_key(primary) {
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
                        let mut groups = self.groups.lock_recover();
                        if let Some(g) = groups.get_mut(group) {
                            g.active = primary.to_string();
                            g.failures = 0;
                            g.probe_ticks = 0;
                            g.last_switch_ms = now;
                            g.last_switch_reason = "primary recovered".into();
                            g.switch_count += 1;
                        }
                    }
                    if let Some(pm) = self.point_manager.lock_recover().as_ref() {
                        pm.lock_recover().set_active_instance(group, primary);
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
}

pub(super) fn resolve_write_target(
    config: &AppConfig,
    groups: &HashMap<String, GroupStateInner>,
    point_name: &str,
) -> Option<(String, String)> {
    config.plugins.instances.iter().find_map(|inst| {
        inst.points.iter().find_map(|pt| {
            // 逻辑键推导统一走点位身份规则（组内以组名为前缀）
            let logical = logical_key(&inst.redundancy_group, &inst.name, &pt.id);
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

#[cfg(test)]
mod tests {
    use super::super::{actor, PluginRegistry};
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
        let reg = PluginRegistry::new(hmi_io_monitor::collector::MonitorCollector::new()).unwrap();
        reg.rebuild_groups(&cfg);
        let groups = reg.groups.lock_recover();
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
                    MemberRef {
                        name: "mb2".into(),
                        role: "primary".into(),
                        priority: 0,
                    },
                    MemberRef {
                        name: "mb1b".into(),
                        role: "backup".into(),
                        priority: 1,
                    },
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
