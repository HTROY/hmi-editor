//! Modbus TCP 插件状态与配置（F18 ③：从 lib.rs 拆分）。

use plugin_kit::{KitState, PointCfg};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    pub host: String,
    pub port: u16,
    pub slave_id: u8,
    #[serde(default)]
    pub points: Vec<PointCfg>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginState {
    pub host: String,
    pub port: u16,
    pub slave_id: u8,
    pub connected: bool,
    pub scan_count: u64,
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
