use serde::{Deserialize, Serialize};

use hmi_io_db::repo::Repo;

/// Top-level configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub plugins: PluginsConfig,
    #[serde(default)]
    pub redundancy: RedundancyConfig,
    #[serde(default)]
    pub alarm: AlarmConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AlarmConfig {
    #[serde(default = "default_alarm_enabled")]
    pub enabled: bool,
    #[serde(default = "default_alarm_retention_days")]
    pub retention_alarm_days: u32,
    #[serde(default = "default_soe_retention_days")]
    pub retention_soe_days: u32,
    #[serde(default)]
    pub rules: Vec<AlarmRuleYaml>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmRuleYaml {
    pub id: String,
    pub variable_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_severity")]
    pub severity: String,
    #[serde(default)]
    pub group: String,
    #[serde(default = "default_condition")]
    pub condition: String,
    #[serde(default)]
    pub threshold: f64,
    #[serde(default = "default_rule_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub hysteresis: f64,
    #[serde(default)]
    pub confirm_ms: u64,
}

fn default_alarm_enabled() -> bool {
    true
}
fn default_alarm_retention_days() -> u32 {
    90
}
fn default_soe_retention_days() -> u32 {
    30
}
fn default_severity() -> String {
    "warning".into()
}
fn default_condition() -> String {
    "high".into()
}
fn default_rule_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_web_port")]
    pub web_port: u16,
    #[serde(default = "default_path")]
    pub path: String,
    /// Batch interval in milliseconds for WebSocket data push (default 100ms)
    #[serde(default = "default_batch_interval")]
    pub batch_interval_ms: u64,
}

fn default_host() -> String {
    "0.0.0.0".into()
}
fn default_port() -> u16 {
    8080
}
fn default_web_port() -> u16 {
    8081
}
fn default_path() -> String {
    "/iscs/data".into()
}
fn default_batch_interval() -> u64 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginsConfig {
    #[serde(default = "default_plugin_dir")]
    pub directory: String,
    #[serde(default = "default_scan_interval")]
    pub scan_interval_ms: u64,
    #[serde(default)]
    pub instances: Vec<PluginInstance>,
}

fn default_plugin_dir() -> String {
    "./plugins".into()
}
fn default_scan_interval() -> u64 {
    500
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInstance {
    pub name: String,
    pub wasm_file: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub points: Vec<PointMapping>,
    #[serde(default)]
    pub redundancy_group: String,
    #[serde(default)]
    pub redundancy_role: String,
    #[serde(default)]
    pub priority: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointMapping {
    pub id: String,
    pub address: String,
    #[serde(default = "default_data_type")]
    pub data_type: String,
    #[serde(default = "default_byte_order")]
    pub byte_order: String,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default)]
    pub offset: f64,
    #[serde(default = "default_var_type")]
    pub var_type: String,
}

fn default_data_type() -> String {
    "uint16".into()
}
fn default_byte_order() -> String {
    "big_endian".into()
}
fn default_scale() -> f64 {
    1.0
}
fn default_var_type() -> String {
    "AI".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NodeRole {
    #[default]
    Primary,
    Backup,
}

impl NodeRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeRole::Primary => "primary",
            NodeRole::Backup => "backup",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedundancyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub role: NodeRole,
    #[serde(default)]
    pub peer_url: String,
    #[serde(default = "default_peer_ws_port")]
    pub peer_ws_port: u16,
    #[serde(default = "default_heartbeat_interval_ms")]
    pub heartbeat_interval_ms: u64,
    #[serde(default = "default_failover_threshold")]
    pub failover_threshold: u32,
    #[serde(default = "default_failback_delay_ms")]
    pub failback_delay_ms: u64,
    #[serde(default = "default_full_snapshot_interval_ms")]
    pub full_snapshot_interval_ms: u64,
    #[serde(default = "default_plugin_unhealthy_threshold")]
    pub plugin_unhealthy_threshold: u32,
    #[serde(default = "default_plugin_promotion_cooldown_ms")]
    pub plugin_promotion_cooldown_ms: u64,
    #[serde(default = "default_instance_failover_threshold")]
    pub instance_failover_threshold: u32,
    #[serde(default = "default_instance_failback_enabled")]
    pub instance_failback_enabled: bool,
    #[serde(default = "default_instance_failback_delay_ms")]
    pub instance_failback_delay_ms: u64,
    #[serde(default = "default_instance_switch_cooldown_ms")]
    pub instance_switch_cooldown_ms: u64,
}

fn default_heartbeat_interval_ms() -> u64 {
    1000
}
fn default_failover_threshold() -> u32 {
    3
}
fn default_failback_delay_ms() -> u64 {
    30_000
}
fn default_full_snapshot_interval_ms() -> u64 {
    5_000
}
fn default_peer_ws_port() -> u16 {
    8080
}
fn default_plugin_unhealthy_threshold() -> u32 {
    3
}
fn default_plugin_promotion_cooldown_ms() -> u64 {
    60_000
}
fn default_instance_failover_threshold() -> u32 {
    3
}
fn default_instance_failback_enabled() -> bool {
    true
}
fn default_instance_failback_delay_ms() -> u64 {
    30_000
}
fn default_instance_switch_cooldown_ms() -> u64 {
    60_000
}

impl Default for RedundancyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            node_id: String::new(),
            role: NodeRole::Primary,
            peer_url: String::new(),
            peer_ws_port: default_peer_ws_port(),
            heartbeat_interval_ms: default_heartbeat_interval_ms(),
            failover_threshold: default_failover_threshold(),
            failback_delay_ms: default_failback_delay_ms(),
            full_snapshot_interval_ms: default_full_snapshot_interval_ms(),
            plugin_unhealthy_threshold: default_plugin_unhealthy_threshold(),
            plugin_promotion_cooldown_ms: default_plugin_promotion_cooldown_ms(),
            instance_failover_threshold: default_instance_failover_threshold(),
            instance_failback_enabled: default_instance_failback_enabled(),
            instance_failback_delay_ms: default_instance_failback_delay_ms(),
            instance_switch_cooldown_ms: default_instance_switch_cooldown_ms(),
        }
    }
}

impl AppConfig {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Ok(serde_yaml::from_str(&content)?)
    }

    pub fn default_config() -> Self {
        Self {
            server: ServerConfig {
                host: default_host(),
                port: default_port(),
                web_port: default_web_port(),
                path: default_path(),
                batch_interval_ms: default_batch_interval(),
            },
            plugins: PluginsConfig {
                directory: default_plugin_dir(),
                scan_interval_ms: default_scan_interval(),
                instances: vec![],
            },
            redundancy: RedundancyConfig::default(),
            alarm: AlarmConfig {
                enabled: default_alarm_enabled(),
                retention_alarm_days: default_alarm_retention_days(),
                retention_soe_days: default_soe_retention_days(),
                rules: vec![],
            },
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        let mut seen = std::collections::HashSet::new();
        for inst in &self.plugins.instances {
            if !seen.insert(inst.name.clone()) {
                anyhow::bail!(
                    "duplicate plugin instance name '{}'; instance names must be unique",
                    inst.name
                );
            }
        }
        if self.redundancy.enabled {
            if self.redundancy.node_id.is_empty() {
                anyhow::bail!("redundancy.node_id is required when redundancy is enabled");
            }
            if self.redundancy.peer_url.is_empty() {
                anyhow::bail!("redundancy.peer_url is required when redundancy is enabled");
            }
            if !self.redundancy.peer_url.starts_with("http://")
                && !self.redundancy.peer_url.starts_with("https://")
            {
                anyhow::bail!("redundancy.peer_url must start with http:// or https://");
            }
        }
        // ---- 实例级组校验 ----
        let mut group_primary: std::collections::HashMap<&str, &PluginInstance> =
            std::collections::HashMap::new();
        let mut group_backups: std::collections::HashMap<&str, Vec<&PluginInstance>> =
            std::collections::HashMap::new();
        for inst in &self.plugins.instances {
            let g = inst.redundancy_group.trim();
            let r = inst.redundancy_role.trim();
            if g.is_empty() && r.is_empty() {
                continue;
            }
            if g.is_empty() || r.is_empty() {
                anyhow::bail!(
                    "instance '{}': redundancy_group and redundancy_role must be set together",
                    inst.name
                );
            }
            match r {
                "primary" => {
                    if inst.priority != 0 {
                        anyhow::bail!("instance '{}': primary must not set priority", inst.name);
                    }
                    if group_primary.insert(g, inst).is_some() {
                        anyhow::bail!("group '{}' has multiple primary instances", g);
                    }
                }
                "backup" => {
                    if inst.priority == 0 {
                        anyhow::bail!("instance '{}': backup must set priority >= 1", inst.name);
                    }
                    group_backups.entry(g).or_default().push(inst);
                }
                _ => anyhow::bail!(
                    "instance '{}': redundancy_role must be 'primary' or 'backup'",
                    inst.name
                ),
            }
        }
        for (g, backups) in &group_backups {
            let primary = match group_primary.get(g) {
                Some(p) => *p,
                None => anyhow::bail!("group '{}' has backups but no primary", g),
            };
            let primary_ids: std::collections::HashSet<&str> =
                primary.points.iter().map(|p| p.id.as_str()).collect();
            let mut seen = std::collections::HashSet::new();
            for b in backups {
                if !seen.insert(b.priority) {
                    anyhow::bail!(
                        "group '{}' has duplicate backup priority {}",
                        g,
                        b.priority
                    );
                }
                let ids: std::collections::HashSet<&str> =
                    b.points.iter().map(|p| p.id.as_str()).collect();
                if ids != primary_ids {
                    anyhow::bail!(
                        "group '{}': backup '{}' point ids must match primary exactly",
                        g,
                        b.name
                    );
                }
            }
        }
        // ---- Alarm rule validation ----
        if self.alarm.enabled {
            let mut rule_ids = std::collections::HashSet::new();
            for r in &self.alarm.rules {
                if r.id.trim().is_empty() || r.variable_id.trim().is_empty() {
                    anyhow::bail!("alarm rule must have non-empty id and variable_id");
                }
                if !rule_ids.insert(r.id.as_str()) {
                    anyhow::bail!("duplicate alarm rule id '{}'", r.id);
                }
                if !matches!(
                    r.condition.as_str(),
                    "high" | "low" | "equal" | "notEqual" | "change"
                ) {
                    anyhow::bail!(
                        "alarm rule '{}': invalid condition '{}'",
                        r.id,
                        r.condition
                    );
                }
                if !matches!(
                    r.severity.as_str(),
                    "critical" | "major" | "minor" | "warning"
                ) {
                    anyhow::bail!("alarm rule '{}': invalid severity '{}'", r.id, r.severity);
                }
            }
        }
        Ok(())
    }

    /// Build AppConfig from the database via Repo
    pub fn from_repo_sync(repo: &Repo) -> Self {
        let scan_interval_ms: u64 = repo
            .get_config("scan_interval_ms")
            .unwrap_or_else(|| "500".into())
            .parse()
            .unwrap_or(500);
        let batch_interval_ms: u64 = repo
            .get_config("batch_interval_ms")
            .unwrap_or_else(|| "100".into())
            .parse()
            .unwrap_or(100);
        let plugin_dir = repo
            .get_config("plugin_dir")
            .unwrap_or_else(|| "./plugins".into());
        let redundancy = repo
            .get_config("redundancy_config")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let alarm = AlarmConfig {
            enabled: true,
            retention_alarm_days: repo
                .get_config("alarm_retention_days")
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(default_alarm_retention_days),
            retention_soe_days: repo
                .get_config("soe_retention_days")
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(default_soe_retention_days),
            rules: vec![],
        };

        let instances = match repo.list_plugins_with_points() {
            Ok(pws) => pws
                .into_iter()
                .filter(|pw| pw.plugin.enabled)
                .map(|pw| PluginInstance {
                    name: pw.plugin.name,
                    wasm_file: pw.plugin.wasm_file,
                    config: serde_json::from_str(&pw.plugin.config_json)
                        .unwrap_or(serde_json::json!({})),
                    points: pw
                        .points
                        .into_iter()
                .map(|p| PointMapping {
                    id: p.variable_id,
                    address: p.address,
                    data_type: p.data_type,
                    byte_order: p.byte_order,
                    scale: p.scale,
                    offset: p.offset_val,
                    var_type: p.var_type,
                })
                .collect(),
                redundancy_group: pw.plugin.redundancy_group.clone(),
                redundancy_role: pw.plugin.redundancy_role.clone(),
                priority: pw.plugin.priority,
            })
                .collect(),
            Err(e) => {
                log::error!("Failed to load plugins from DB: {}", e);
                vec![]
            }
        };

        AppConfig {
            server: ServerConfig {
                host: repo
                    .get_config("ws_host")
                    .unwrap_or_else(|| "0.0.0.0".into()),
                port: repo
                    .get_config("ws_port")
                    .unwrap_or_else(|| "8080".into())
                    .parse()
                    .unwrap_or(8080),
                web_port: repo
                    .get_config("web_port")
                    .unwrap_or_else(|| "8081".into())
                    .parse()
                    .unwrap_or(8081),
                path: "/iscs/data".into(),
                batch_interval_ms,
            },
            plugins: PluginsConfig {
                directory: plugin_dir,
                scan_interval_ms,
                instances,
            },
            redundancy,
            alarm,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(name: &str) -> PluginInstance {
        PluginInstance {
            name: name.into(),
            wasm_file: "p.wasm".into(),
            config: serde_json::json!({}),
            points: vec![],
            redundancy_group: String::new(),
            redundancy_role: String::new(),
            priority: 0,
        }
    }

    fn group_instance(
        name: &str,
        group: &str,
        role: &str,
        priority: u32,
        ids: &[&str],
    ) -> PluginInstance {
        PluginInstance {
            name: name.into(),
            wasm_file: "p.wasm".into(),
            config: serde_json::json!({}),
            points: ids
                .iter()
                .map(|id| PointMapping {
                    id: id.to_string(),
                    address: "a".into(),
                    data_type: "uint16".into(),
                    byte_order: "big_endian".into(),
                    scale: 1.0,
                    offset: 0.0,
                    var_type: "AI".into(),
                })
                .collect(),
            redundancy_group: group.into(),
            redundancy_role: role.into(),
            priority,
        }
    }

    #[test]
    fn redundancy_config_new_defaults() {
        let cfg = RedundancyConfig::default();
        assert_eq!(cfg.peer_ws_port, 8080);
        assert_eq!(cfg.plugin_unhealthy_threshold, 3);
        assert_eq!(cfg.plugin_promotion_cooldown_ms, 60_000);
        assert_eq!(cfg.instance_failover_threshold, 3);
        assert!(cfg.instance_failback_enabled);
        assert_eq!(cfg.instance_failback_delay_ms, 30_000);
        assert_eq!(cfg.instance_switch_cooldown_ms, 60_000);
    }

    #[test]
    fn validate_rejects_multiple_primaries_in_group() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
            group_instance("mb2", "mb-link", "primary", 0, &["P1"]),
        ];
        let err = cfg.validate().unwrap_err();
        assert!(err.to_string().contains("multiple primary"));
    }

    #[test]
    fn validate_rejects_backup_without_priority() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
            group_instance("mb2", "mb-link", "backup", 0, &["P1"]),
        ];
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_duplicate_backup_priority() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
            group_instance("mb2", "mb-link", "backup", 1, &["P1"]),
            group_instance("mb3", "mb-link", "backup", 1, &["P1"]),
        ];
        let err = cfg.validate().unwrap_err();
        assert!(err.to_string().contains("duplicate backup priority"));
    }

    #[test]
    fn validate_rejects_point_set_mismatch() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            group_instance("mb1", "mb-link", "primary", 0, &["P1", "P2"]),
            group_instance("mb2", "mb-link", "backup", 1, &["P1"]),
        ];
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_accepts_standalone_and_grouped() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            group_instance("standalone", "", "", 0, &["P1"]),
            group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
            group_instance("mb2", "mb-link", "backup", 1, &["P1"]),
            group_instance("mb3", "mb-link", "backup", 2, &["P1"]),
        ];
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_accepts_unique_instance_names() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![instance("modbus_1"), instance("modbus_2")];
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_rejects_duplicate_instance_names() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![instance("modbus_tcp"), instance("modbus_tcp")];
        let err = cfg.validate().unwrap_err();
        assert!(err.to_string().contains("modbus_tcp"));
    }

    #[test]
    fn redundancy_config_defaults_disable_redundancy() {
        let cfg = RedundancyConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.role, NodeRole::Primary);
        assert_eq!(cfg.heartbeat_interval_ms, 1000);
        assert_eq!(cfg.failover_threshold, 3);
        assert_eq!(cfg.failback_delay_ms, 30_000);
        assert_eq!(cfg.full_snapshot_interval_ms, 5_000);
    }

    #[test]
    fn validate_requires_peer_url_when_enabled() {
        let mut cfg = AppConfig::default_config();
        cfg.redundancy.enabled = true;
        cfg.redundancy.node_id = "node-a".into();
        let err = cfg.validate().unwrap_err();
        assert!(err.to_string().contains("peer_url"));
    }

    #[test]
    fn yaml_round_trip_preserves_redundancy() {
        let yaml = r#"
server:
  host: 0.0.0.0
  port: 8080
  path: /iscs/data
plugins:
  directory: ./plugins
  scan_interval_ms: 500
  instances: []
redundancy:
  enabled: true
  node_id: node-a
  role: primary
  peer_url: "http://192.168.1.2:8081"
"#;
        let cfg: AppConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(cfg.redundancy.enabled);
        assert_eq!(cfg.redundancy.node_id, "node-a");
        assert_eq!(cfg.redundancy.role, NodeRole::Primary);
    }

    #[test]
    fn from_repo_sync_reads_redundancy_config() {
        let repo = Repo::new(":memory:").unwrap();
        repo.set_config(
            "redundancy_config",
            r#"{"enabled":true,"node_id":"node-b","role":"backup"}"#,
        )
        .unwrap();
        let cfg = AppConfig::from_repo_sync(&repo);
        assert!(cfg.redundancy.enabled);
        assert_eq!(cfg.redundancy.role, NodeRole::Backup);
    }
}
