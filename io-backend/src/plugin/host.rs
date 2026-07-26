use std::sync::Arc;
use wasmtime::*;
use wasmtime_wasi::WasiCtxBuilder;
use tokio::sync::mpsc;
use super::interface::PluginInstance;
use crate::point::types::PointValue;
use crate::monitor::collector::MonitorCollector;

pub struct PluginHost { engine: Engine }

impl PluginHost {
    pub fn new() -> anyhow::Result<Self> {
        let mut config = Config::default();
        config.wasm_component_model(false);
        Ok(Self { engine: Engine::new(&config)? })
    }

    pub fn load_plugin(
        &self,
        wasm_path: &str,
        point_tx: mpsc::UnboundedSender<PointValue>,
        monitor: Arc<MonitorCollector>,
        plugin_name: &str,
    ) -> anyhow::Result<PluginInstance> {
        let module = Module::from_file(&self.engine, wasm_path)?;
        let mut linker = Linker::new(&self.engine);
        self.register_host_functions(&mut linker, point_tx, monitor, plugin_name)?;
        let wasi_ctx = WasiCtxBuilder::new().inherit_stdio().inherit_env().build();
        let mut store = Store::new(&self.engine, wasi_ctx);
        let instance = linker.instantiate(&mut store, &module)?;
        PluginInstance::new(instance, store)
    }

    fn register_host_functions(
        &self,
        linker: &mut Linker<wasmtime_wasi::WasiCtx>,
        point_tx: mpsc::UnboundedSender<PointValue>,
        monitor: Arc<MonitorCollector>,
        plugin_name: &str,
    ) -> anyhow::Result<()> {
        let tx = point_tx;
        let mon1 = monitor.clone();
        let pn = plugin_name.to_string();
        linker.func_wrap(super::interface::HOST_MODULE, super::interface::IMPORT_ON_POINT,
            move |mut caller: Caller<'_, wasmtime_wasi::WasiCtx>, name_ptr: i32, name_len: i32, value: f64,
                  quality_ptr: i32, quality_len: i32, timestamp: i64| {
                if name_ptr < 0 || name_len <= 0 { return; }
                let mem = match caller.get_export("memory").and_then(|e| e.into_memory()) { Some(m) => m, None => return };
                let data = mem.data(&caller);
                let name = read_str(data, name_ptr as usize, name_len as usize);
                let quality = if quality_ptr >= 0 && quality_len > 0 { read_str(data, quality_ptr as usize, quality_len as usize) } else { "good".into() };
                if !name.is_empty() {
                    let pv = PointValue::new(&name, value, &quality, timestamp as u64);
                    mon1.update_point_value(&pn, &pv);
                    let _ = tx.send(pv);
                }
            },
        )?;
        let mon2 = monitor.clone();
        let pn2 = plugin_name.to_string();
        linker.func_wrap(super::interface::HOST_MODULE, super::interface::IMPORT_LOG,
            move |mut caller: Caller<'_, wasmtime_wasi::WasiCtx>, level: i32, msg_ptr: i32, msg_len: i32| {
                if msg_ptr < 0 || msg_len <= 0 { return; }
                if let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let data = mem.data(&caller);
                    let msg = read_str(data, msg_ptr as usize, msg_len as usize);
                    if msg.contains("TX:") || msg.contains("tx:") {
                        mon2.log_packet(&pn2, "tx", &pn2, extract_hex(&msg), &msg);
                    } else if msg.contains("RX:") || msg.contains("rx:") {
                        mon2.log_packet(&pn2, "rx", &pn2, extract_hex(&msg), &msg);
                    }
                    match level { 0 => log::error!("[plugin] {}", msg), 1 => log::warn!("[plugin] {}", msg), 2 => log::info!("[plugin] {}", msg), _ => log::debug!("[plugin] {}", msg) }
                }
            },
        )?;
        linker.func_wrap(super::interface::HOST_MODULE, super::interface::IMPORT_NOW_MS, || -> i64 {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
        })?;

        let mon3 = monitor.clone();
        let pn3 = plugin_name.to_string();
        linker.func_wrap(super::interface::HOST_MODULE, super::interface::IMPORT_ON_PACKET,
            move |mut caller: Caller<'_, wasmtime_wasi::WasiCtx>,
                  dir_ptr: i32, dir_len: i32,
                  proto_ptr: i32, proto_len: i32,
                  hex_ptr: i32, hex_len: i32,
                  sum_ptr: i32, sum_len: i32| {
                if hex_ptr < 0 || hex_len <= 0 { return; }
                let mem = match caller.get_export("memory").and_then(|e| e.into_memory()) { Some(m) => m, None => return };
                let data = mem.data(&caller);
                let direction = read_str(data, dir_ptr as usize, dir_len as usize);
                let protocol = read_str(data, proto_ptr as usize, proto_len as usize);
                let hex_dump = read_str(data, hex_ptr as usize, hex_len as usize);
                let summary = if sum_ptr >= 0 && sum_len > 0 { read_str(data, sum_ptr as usize, sum_len as usize) } else { String::new() };
                mon3.log_packet(&pn3, &direction, &protocol, &hex_dump, &summary);
            },
        )?;
        Ok(())
    }
}

fn read_str(data: &[u8], ptr: usize, len: usize) -> String {
    let end = (ptr + len).min(data.len());
    if ptr < data.len() { String::from_utf8_lossy(&data[ptr..end]).to_string() } else { String::new() }
}

fn extract_hex(msg: &str) -> &str {
    if let Some(pos) = msg.find(": ") {
        let rest = &msg[pos+2..];
        if rest.chars().all(|c| c.is_ascii_hexdigit() || c == ' ') && rest.len() > 2 {
            return rest;
        }
    }
    msg
}
