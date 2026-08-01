//! wasmtime component Plugin Instance Wrapper
//!
//! Typed wrapper around the `hmi:plugin` lifecycle instance providing a clean
//! async API for plugin lifecycle: init, connect, scan_points, write_point.

use wasmtime::Store;

use super::host::{HostState, Lifecycle};

pub struct PluginInstance {
    store: Store<HostState>,
    lifecycle: Lifecycle,
}

impl PluginInstance {
    pub fn new(store: Store<HostState>, lifecycle: Lifecycle) -> Self {
        Self { store, lifecycle }
    }

    pub async fn init(&mut self, config_json: &str) -> anyhow::Result<u32> {
        let cfg = config_json.to_string();
        let r = self
            .store
            .run_concurrent(async |accessor| self.lifecycle.call_init(accessor, cfg).await)
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_init failed: {}", e))
    }

    pub async fn connect(&mut self) -> anyhow::Result<u32> {
        let r = self
            .store
            .run_concurrent(async |accessor| self.lifecycle.call_connect(accessor).await)
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_connect failed: {}", e))
    }

    pub async fn disconnect(&mut self) -> anyhow::Result<u32> {
        let r = self
            .store
            .run_concurrent(async |accessor| self.lifecycle.call_disconnect(accessor).await)
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_disconnect failed: {}", e))
    }

    pub async fn scan_points(&mut self) -> anyhow::Result<u32> {
        let r = self
            .store
            .run_concurrent(async |accessor| self.lifecycle.call_scan_points(accessor).await)
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_scan_points failed: {}", e))
    }

    pub async fn write_point(&mut self, point_name: &str, value: f64) -> anyhow::Result<u32> {
        let name = point_name.to_string();
        let r = self
            .store
            .run_concurrent(async |accessor| {
                self.lifecycle.call_write_point(accessor, name, value).await
            })
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_write_point failed: {}", e))
    }

    pub async fn get_name(&mut self) -> anyhow::Result<String> {
        let r = self
            .store
            .run_concurrent(async |accessor| self.lifecycle.call_get_name(accessor).await)
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_get_name failed: {}", e))
    }

    pub async fn get_status(&mut self) -> anyhow::Result<u32> {
        let r = self
            .store
            .run_concurrent(async |accessor| self.lifecycle.call_get_status(accessor).await)
            .await?;
        r.map_err(|e| anyhow::anyhow!("plugin_get_status failed: {}", e))
    }
}
