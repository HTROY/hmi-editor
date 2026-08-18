//! OPC UA 插件配置与运行状态（F18）。

use plugin_kit::{KitState, PointCfg};
use serde::{Deserialize, Serialize};
use ua_core::NodeId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    pub endpoint: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub points: Vec<PointCfg>,
}

#[derive(Debug, Clone)]
pub struct PluginState {
    pub host: String,
    pub port: u16,
    pub endpoint: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub connected: bool,
    pub session_active: bool,
    pub channel_id: u32,
    pub token_id: u32,
    pub seq: u32,
    pub handle: u32,
    pub auth_token: NodeId,
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
