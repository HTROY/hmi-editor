//! WASM Plugin Interface - typed wrapper around wasmtime Instance + Store

use wasmtime::*;

// Plugins import from "env" module by default when using extern "C"
pub const HOST_MODULE: &str = "env";
pub const EXPORT_INIT: &str = "plugin_init";
pub const EXPORT_CONNECT: &str = "plugin_connect";
pub const EXPORT_DISCONNECT: &str = "plugin_disconnect";
pub const EXPORT_SCAN_POINTS: &str = "plugin_scan_points";
pub const EXPORT_WRITE_POINT: &str = "plugin_write_point";
pub const EXPORT_GET_NAME: &str = "plugin_get_name";
pub const EXPORT_GET_STATUS: &str = "plugin_get_status";
pub const EXPORT_ALLOC: &str = "plugin_alloc";
pub const EXPORT_FREE: &str = "plugin_free";

pub const IMPORT_ON_POINT: &str = "host_on_point";
pub const IMPORT_LOG: &str = "host_log";
pub const IMPORT_NOW_MS: &str = "host_now_ms";

pub const IMPORT_ON_PACKET: &str = "host_on_packet";

pub struct PluginInstance {
    store: Store<wasmtime_wasi::WasiCtx>,
    init_fn: TypedFunc<(i32, i32), i32>,
    connect_fn: TypedFunc<(), i32>,
    disconnect_fn: TypedFunc<(), i32>,
    scan_fn: TypedFunc<(), i32>,
    write_fn: TypedFunc<(i32, i32, i32, i32), i32>,
    get_name_fn: TypedFunc<(i32, i32), i32>,
    get_status_fn: TypedFunc<(), i32>,
    alloc_fn: TypedFunc<i32, i32>,
    memory: Memory,
}

impl PluginInstance {
    pub fn new(instance: Instance, mut store: Store<wasmtime_wasi::WasiCtx>) -> anyhow::Result<Self> {
        let memory = instance.get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow::anyhow!("plugin must export 'memory'"))?;
        Ok(Self {
            init_fn: instance.get_typed_func(&mut store, EXPORT_INIT)?,
            connect_fn: instance.get_typed_func(&mut store, EXPORT_CONNECT)?,
            disconnect_fn: instance.get_typed_func(&mut store, EXPORT_DISCONNECT)?,
            scan_fn: instance.get_typed_func(&mut store, EXPORT_SCAN_POINTS)?,
            write_fn: instance.get_typed_func(&mut store, EXPORT_WRITE_POINT)?,
            get_name_fn: instance.get_typed_func(&mut store, EXPORT_GET_NAME)?,
            get_status_fn: instance.get_typed_func(&mut store, EXPORT_GET_STATUS)?,
            alloc_fn: instance.get_typed_func(&mut store, EXPORT_ALLOC)?,
            memory, store,
        })
    }

    pub fn init(&mut self, config_json: &str) -> anyhow::Result<i32> {
        let (ptr, len) = self.write_string(config_json)?;
        Ok(self.init_fn.call(&mut self.store, (ptr as i32, len as i32))?)
    }
    pub fn connect(&mut self) -> anyhow::Result<i32> { Ok(self.connect_fn.call(&mut self.store, ())?) }
    pub fn disconnect(&mut self) -> anyhow::Result<i32> { Ok(self.disconnect_fn.call(&mut self.store, ())?) }
    pub fn scan_points(&mut self) -> anyhow::Result<i32> { Ok(self.scan_fn.call(&mut self.store, ())?) }

    pub fn write_point(&mut self, point_name: &str, value: f64) -> anyhow::Result<i32> {
        let (np, nl) = self.write_string(point_name)?;
        let vs = value.to_string();
        let (vp, vl) = self.write_string(&vs)?;
        Ok(self.write_fn.call(&mut self.store, (np as i32, nl as i32, vp as i32, vl as i32))?)
    }

    pub fn get_name(&mut self) -> anyhow::Result<String> {
        let sz: i32 = 256;
        let bp = self.alloc_fn.call(&mut self.store, sz)?;
        let len = self.get_name_fn.call(&mut self.store, (bp, sz))?;
        if len <= 0 || len > sz { return Ok("unknown".into()); }
        self.read_string(bp as usize, len as usize)
    }
    pub fn get_status(&mut self) -> anyhow::Result<i32> { Ok(self.get_status_fn.call(&mut self.store, ())?) }

    pub fn write_string(&mut self, s: &str) -> anyhow::Result<(usize, usize)> {
        let bytes = s.as_bytes();
        let len = bytes.len() as i32;
        let ptr = self.alloc_fn.call(&mut self.store, len)?;
        let data = self.memory.data_mut(&mut self.store);
        let start = ptr as usize;
        data[start..start + bytes.len()].copy_from_slice(bytes);
        Ok((ptr as usize, bytes.len()))
    }
    pub fn read_string(&self, ptr: usize, len: usize) -> anyhow::Result<String> {
        let data = self.memory.data(&self.store);
        let end = (ptr + len).min(data.len());
        Ok(String::from_utf8_lossy(&data[ptr..end]).to_string())
    }
}

