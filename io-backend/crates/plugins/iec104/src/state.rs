//! IEC 60870-5-104 插件配置与运行状态（F18）。

use plugin_kit::{KitState, PointCfg};
use serde::{Deserialize, Serialize};

pub type Pc = PointCfg;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    pub host: String,
    pub port: u16,
    pub common_address: u16,
    #[serde(default)]
    pub points: Vec<PointCfg>,
}

#[derive(Debug, Clone)]
pub struct PendingCmd {
    pub variable_id: String,
    pub ioa: u32,
    pub at: u64,
}

#[derive(Debug, Clone)]
pub struct PluginState {
    pub host: String,
    pub port: u16,
    pub common_address: u16,
    pub connected: bool,
    pub scan_count: u64,
    /// Next send sequence number (I-frame).
    pub send_seq: u16,
    /// Next expected receive sequence number (I-frame).
    pub recv_seq: u16,
    /// Time of the last frame received from the server.
    pub last_rx: u64,
    /// TESTFR sent but no TESTFR_CON yet.
    pub testfr_pending: bool,
    /// C_IC_NA_1 sent since the last STARTDT_CON.
    pub interrogation_sent: bool,
    pub pending: Vec<PendingCmd>,
    pub points: Vec<PointCfg>,
}

impl KitState for PluginState {
    fn connected(&self) -> bool {
        self.connected
    }

    fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
    }

    fn bump_scan_count(&mut self) {
        self.scan_count += 1;
    }
}
