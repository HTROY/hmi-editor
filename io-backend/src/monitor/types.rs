//! Monitor types — serializable structs for status, packets, and snapshots

use serde::Serialize;

/// Per-plugin runtime status
#[derive(Debug, Clone, Serialize)]
pub struct PluginStatus {
    pub name: String,
    pub wasm_file: String,
    /// 0=disconnected, 1=connecting, 2=connected, 3=error
    pub connection_state: i32,
    pub connection_label: String,
    pub scan_count: u64,
    pub error_count: u64,
    pub last_scan_time_ms: u64,
    pub last_error: String,
    pub last_error_time_ms: u64,
    pub uptime_ms: u64,
    pub start_time_ms: u64,
}

/// A single network-level packet log entry
#[derive(Debug, Clone, Serialize)]
pub struct PacketLogEntry {
    pub timestamp_ms: u64,
    pub direction: String, // "tx" or "rx"
    pub protocol: String,  // "modbus", "opcua", "iec104"
    pub length: usize,
    pub hex_dump: String, // hex string like "01 03 00 00 00 0A C5 CD"
    pub summary: String,  // human-readable summary like "Read Holding Registers [0-9]"
}

/// Live point value snapshot for the monitoring UI
#[derive(Debug, Clone, Serialize)]
pub struct LivePointInfo {
    pub variable_id: String,
    pub address: String,
    pub var_type: String,
    pub value: serde_json::Value,
    pub quality: String,
    pub timestamp_ms: u64,
    pub age_ms: u64, // how stale the value is (now - timestamp)
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
}

/// Full monitoring snapshot returned by API
#[derive(Debug, Clone, Serialize)]
pub struct MonitorSnapshot {
    pub server_uptime_ms: u64,
    pub plugins: Vec<PluginStatus>,
    pub total_scans: u64,
    pub total_errors: u64,
    pub total_points: usize,
    pub active_ws_clients: usize,
}

/// WebSocket status message for live updates
#[derive(Debug, Clone, Serialize)]
pub struct WsMonitorMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub plugin_name: String,
    pub status: Option<PluginStatus>,
    pub points: Option<Vec<LivePointInfo>>,
    pub packet: Option<PacketLogEntry>,
}
