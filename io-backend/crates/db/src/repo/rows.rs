//! Row structs shared across repository submodules. Re-exported from the
//! `repo` module root, so consumers keep using `hmi_io_db::repo::*`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRow {
    pub id: i64,
    pub name: String,
    pub wasm_file: String,
    pub config_json: String,
    pub enabled: bool,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub priority: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointRow {
    pub id: i64,
    pub plugin_id: i64,
    pub plugin_name: String,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginWithPoints {
    pub plugin: PluginRow,
    pub points: Vec<PointRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub config_version: u64,
    pub scan_interval_ms: u64,
    pub batch_interval_ms: u64,
    pub plugin_dir: String,
    pub redundancy: serde_json::Value,
    pub alarm_retention_days: u32,
    pub soe_retention_days: u32,
    pub alarm_rules: Vec<SnapshotAlarmRule>,
    pub plugins: Vec<SnapshotPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPlugin {
    pub name: String,
    pub wasm_file: String,
    pub config_json: String,
    pub enabled: bool,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub priority: u32,
    pub points: Vec<SnapshotPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPoint {
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotAlarmRule {
    pub id: String,
    pub variable_id: String,
    pub name: String,
    pub description: String,
    pub severity: String,
    pub group_name: String,
    pub condition: String,
    pub threshold: f64,
    pub enabled: bool,
    pub hysteresis: f64,
    pub confirm_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmRuleRow {
    pub id: String,
    pub variable_id: String,
    pub name: String,
    pub description: String,
    pub severity: String,
    pub group_name: String,
    pub condition: String,
    pub threshold: f64,
    pub enabled: bool,
    pub hysteresis: f64,
    pub confirm_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmOccurrenceRow {
    pub id: String,
    pub rule_id: String,
    pub variable_id: String,
    pub name: String,
    pub severity: String,
    pub group_name: String,
    pub message: String,
    pub value: String,
    pub threshold: f64,
    pub status: String,
    pub triggered_at: u64,
    pub recovered_at: Option<u64>,
    pub recovered_reason: String,
    pub acknowledged_at: Option<u64>,
    pub acknowledged_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmStreamEventRow {
    pub id: i64,
    pub occurrence_id: String,
    pub event_type: String,
    pub at_ms: u64,
    pub by_user: String,
    pub value: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoeRow {
    pub id: i64,
    pub seq: i64,
    pub variable_id: String,
    pub value: String,
    pub quality: String,
    pub device_time: u64,
    pub receive_time: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub schema_version: u32,
    pub version: u64,
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogRow {
    pub id: i64,
    pub action: String,
    pub project_id: String,
    pub project_name: String,
    pub version: u64,
    pub actor: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub must_change_password: bool,
    pub token_version: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPushResult {
    pub created: bool,
    pub version: u64,
}
