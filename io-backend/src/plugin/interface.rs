//! Extism Plugin Instance Wrapper
//!
//! Typed wrapper around `extism::Plugin` providing a clean API
//! for the plugin lifecycle: init, connect, scan_points, write_point, etc.

use extism::*;

pub struct PluginInstance {
    plugin: Plugin,
}

impl PluginInstance {
    pub fn new(plugin: Plugin) -> anyhow::Result<Self> {
        Ok(Self { plugin })
    }

    pub fn init(&mut self, config_json: &str) -> anyhow::Result<i32> {
        self.plugin
            .call("plugin_init", config_json)
            .map_err(|e| anyhow::anyhow!("plugin_init failed: {}", e))
    }

    pub fn connect(&mut self) -> anyhow::Result<i32> {
        self.plugin
            .call::<&str, i32>("plugin_connect", "")
            .map_err(|e| anyhow::anyhow!("plugin_connect failed: {}", e))
    }

    pub fn disconnect(&mut self) -> anyhow::Result<i32> {
        self.plugin
            .call::<&str, i32>("plugin_disconnect", "")
            .map_err(|e| anyhow::anyhow!("plugin_disconnect failed: {}", e))
    }

    pub fn scan_points(&mut self) -> anyhow::Result<i32> {
        self.plugin
            .call::<&str, i32>("plugin_scan_points", "")
            .map_err(|e| anyhow::anyhow!("plugin_scan_points failed: {}", e))
    }

    pub fn write_point(&mut self, point_name: &str, value: f64) -> anyhow::Result<i32> {
        let input = serde_json::json!({ "name": point_name, "value": value }).to_string();
        self.plugin
            .call("plugin_write_point", input)
            .map_err(|e| anyhow::anyhow!("plugin_write_point failed: {}", e))
    }

    pub fn get_name(&mut self) -> anyhow::Result<String> {
        self.plugin
            .call::<&str, String>("plugin_get_name", "")
            .map_err(|e| anyhow::anyhow!("plugin_get_name failed: {}", e))
    }

    pub fn get_status(&mut self) -> anyhow::Result<i32> {
        self.plugin
            .call::<&str, i32>("plugin_get_status", "")
            .map_err(|e| anyhow::anyhow!("plugin_get_status failed: {}", e))
    }
}
