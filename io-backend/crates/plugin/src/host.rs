//! wasmtime host for the `hmi:plugin` world.
//!
//! Loads wasip2 components, implements the `events` import (log / on-point /
//! on-packet), and exposes a `PluginHost::load_plugin` factory producing
//! `PluginInstance` handles.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::mpsc;
use wasmtime::component::{bindgen, Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

use super::interface::PluginInstance;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_point::{point_key, types::PointValue};

use hmi::plugin::events;

bindgen!({
    world: "hmi-plugin",
    path: "../../wit",
});

pub type Lifecycle = exports::hmi::plugin::lifecycle::Guest;

pub struct HostState {
    pub wasi: WasiCtx,
    pub table: ResourceTable,
    point_tx: mpsc::UnboundedSender<PointValue>,
    monitor: Arc<MonitorCollector>,
    plugin_name: String,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl wasmtime::component::HasData for HostState {
    type Data<'a> = &'a mut HostState;
}

impl events::Host for HostState {}

fn outgoing_point(
    plugin_name: &str,
    variable_id: &str,
    value: f64,
    quality: &str,
    timestamp: u64,
) -> PointValue {
    PointValue::new(
        &point_key(plugin_name, variable_id),
        value,
        quality,
        timestamp,
    )
}

impl events::HostWithStore<HostState> for HostState {
    fn log(
        accessor: &wasmtime::component::Accessor<HostState, HostState>,
        level: u32,
        message: String,
    ) -> impl Future<Output = ()> + Send {
        async move {
            accessor.with(|mut access| {
                let s: &mut HostState = access.get();
                let pn = s.plugin_name.clone();
                if level <= 4 {
                    match level {
                        0 => log::error!("[{}] {}", pn, message),
                        1 => log::warn!("[{}] {}", pn, message),
                        2 => log::info!("[{}] {}", pn, message),
                        _ => log::debug!("[{}] {}", pn, message),
                    }
                }
            });
        }
    }

    fn on_point(
        accessor: &wasmtime::component::Accessor<HostState, HostState>,
        name: String,
        value: f64,
        quality: String,
        timestamp: u64,
    ) -> impl Future<Output = ()> + Send {
        async move {
            accessor.with(|mut access| {
                let s: &mut HostState = access.get();
                let qs = if quality.is_empty() { "good" } else { &quality };
                let raw = PointValue::new(&name, value, qs, timestamp);
                s.monitor.update_point_value(&s.plugin_name, &raw);
                let _ = s
                    .point_tx
                    .send(outgoing_point(&s.plugin_name, &name, value, qs, timestamp));
            });
        }
    }

    fn on_packet(
        accessor: &wasmtime::component::Accessor<HostState, HostState>,
        direction: String,
        protocol: String,
        hex: String,
        summary: String,
    ) -> impl Future<Output = ()> + Send {
        async move {
            accessor.with(|mut access| {
                let s: &mut HostState = access.get();
                s.monitor
                    .log_packet(&s.plugin_name, &direction, &protocol, &hex, &summary);
            });
        }
    }
}

pub struct PluginHost {
    engine: Engine,
}

impl PluginHost {
    pub fn new() -> anyhow::Result<Self> {
        let mut config = Config::new();
        config.concurrency_support(true);
        Ok(Self {
            engine: Engine::new(&config)?,
        })
    }

    pub async fn load_plugin(
        &self,
        wasm_path: &str,
        point_tx: mpsc::UnboundedSender<PointValue>,
        monitor: Arc<MonitorCollector>,
        plugin_name: &str,
    ) -> anyhow::Result<PluginInstance> {
        let mut linker = Linker::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        HmiPlugin::add_to_linker::<HostState, HostState>(&mut linker, |x| x)?;

        let wasi = WasiCtx::builder()
            .inherit_network()
            .allow_tcp(true)
            .allow_udp(true)
            .allow_ip_name_lookup(true)
            .build();
        let state = HostState {
            wasi,
            table: ResourceTable::new(),
            point_tx,
            monitor,
            plugin_name: plugin_name.to_string(),
        };
        let mut store = Store::new(&self.engine, state);

        let component = Component::from_file(&self.engine, wasm_path)
            .map_err(|e| anyhow::anyhow!("Failed to load component '{}': {}", wasm_path, e))?;
        let inst = HmiPlugin::instantiate_async(&mut store, &component, &linker)
            .await
            .map_err(|e| {
                anyhow::anyhow!("Failed to instantiate plugin '{}': {}", plugin_name, e)
            })?;
        let lifecycle = inst.hmi_plugin_lifecycle().clone();
        Ok(PluginInstance::new(store, lifecycle))
    }
}

#[cfg(test)]
mod tests {
    use super::outgoing_point;

    #[test]
    fn outgoing_point_uses_composite_key() {
        let pv = outgoing_point("mb1", "P1", 42.0, "good", 1000);
        assert_eq!(pv.id, "mb1:P1");
        assert_eq!(pv.value, serde_json::json!(42.0));
    }
}
