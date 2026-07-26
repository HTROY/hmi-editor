//! IEC 60870-5-104 Protocol Plugin (WASM)
//!
//! Simulates IEC 104 communication (used in power grid / rail transit SCADA).
//! In real deployment, this would implement the full IEC 104 protocol stack
//! including APCI/ASDU framing, spontaneous and cyclic data transmission.

use serde::Deserialize;
use std::collections::HashMap;

extern "C" {
    fn host_on_point(
        name_ptr: *const u8, name_len: i32,
        value: f64,
        quality_ptr: *const u8, quality_len: i32,
        timestamp: i64,
    );
    fn host_log(level: i32, msg_ptr: *const u8, msg_len: i32);
    fn host_now_ms() -> i64;
}

static mut STATE: Option<PluginState> = None;

struct PluginState {
    host: String,
    port: u16,
    common_address: u16,
    connected: bool,
    scan_count: u64,
}

#[derive(Deserialize)]
struct PluginConfig {
    host: String,
    port: u16,
    common_address: u16,
}

#[no_mangle]
pub extern "C" fn plugin_init(config_ptr: *const u8, config_len: i32) -> i32 {
    let config_str = unsafe {
        let slice = std::slice::from_raw_parts(config_ptr, config_len as usize);
        match std::str::from_utf8(slice) { Ok(s) => s, Err(_) => return 1 }
    };
    let config: PluginConfig = match serde_json::from_str(config_str) {
        Ok(c) => c, Err(_) => { log_host(0, "Failed to parse IEC 104 config"); return 2; }
    };
    log_host(2, &format!("IEC 104 plugin init: {}:{}, CASDU={}", config.host, config.port, config.common_address));
    unsafe { STATE = Some(PluginState { host: config.host, port: config.port, common_address: config.common_address, connected: false, scan_count: 0 }); }
    0
}

#[no_mangle]
pub extern "C" fn plugin_connect() -> i32 {
    let state = unsafe { STATE.as_mut().expect("plugin not initialized") };
    log_host(2, &format!("IEC 104 connecting to {}:{}...", state.host, state.port));
    state.connected = true;
    log_host(2, "IEC 104 connected (simulated)");
    0
}

#[no_mangle]
pub extern "C" fn plugin_disconnect() -> i32 {
    let state = unsafe { STATE.as_mut().expect("plugin not initialized") };
    state.connected = false;
    log_host(2, "IEC 104 disconnected");
    0
}

#[no_mangle]
pub extern "C" fn plugin_scan_points() -> i32 {
    let state = unsafe { STATE.as_mut().expect("plugin not initialized") };
    if !state.connected { return 1; }
    state.scan_count += 1;
    let now = unsafe { host_now_ms() };
    let quality = b"good";
    let q_len = quality.len() as i32;

    let di_points: Vec<(u32, f64)> = vec![
        (1001, if state.scan_count % 3 == 0 { 1.0 } else { 0.0 }),
        (1002, if state.scan_count % 4 == 0 { 1.0 } else { 0.0 }),
        (3001, if state.scan_count % 2 == 0 { 1.0 } else { 0.0 }),
    ];
    for (ioa, val) in &di_points {
        let addr_str = ioa.to_string();
        unsafe { host_on_point(addr_str.as_ptr(), addr_str.len() as i32, *val, quality.as_ptr(), q_len, now); }
    }

    let ai_points: Vec<(u32, f64)> = vec![
        (1003, 800.0 + ((state.scan_count as f64 * 0.1).sin() * 200.0)),
        (1004, 780.0 + ((state.scan_count as f64 * 0.12).sin() * 190.0)),
        (1005, 400.0 + ((state.scan_count as f64 * 0.05).sin() * 15.0)),
        (3002, 2400.0 + ((state.scan_count as f64 * 0.08).sin() * 600.0)),
    ];
    for (ioa, val) in &ai_points {
        let rounded = (val * 100.0).round() / 100.0;
        let addr_str = ioa.to_string();
        unsafe { host_on_point(addr_str.as_ptr(), addr_str.len() as i32, rounded, quality.as_ptr(), q_len, now); }
    }
    0
}

#[no_mangle]
pub extern "C" fn plugin_write_point(
    name_ptr: *const u8, name_len: i32, value_ptr: *const u8, value_len: i32,
) -> i32 {
    let name = unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(name_ptr, name_len as usize)).to_string() };
    let value_str = unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(value_ptr, value_len as usize)).to_string() };
    let value: f64 = match value_str.parse() { Ok(v) => v, Err(_) => return 1 };
    log_host(2, &format!("IEC 104 write: IOA {} = {}", name, value));
    let now = unsafe { host_now_ms() };
    let quality = b"good";
    unsafe { host_on_point(name.as_ptr(), name.len() as i32, value, quality.as_ptr(), quality.len() as i32, now); }
    0
}

#[no_mangle]
pub extern "C" fn plugin_get_name(ptr: *mut u8, max_len: i32) -> i32 {
    let name = b"IEC 60870-5-104";
    let len = name.len().min(max_len as usize);
    unsafe { std::ptr::copy_nonoverlapping(name.as_ptr(), ptr, len); }
    len as i32
}

#[no_mangle]
pub extern "C" fn plugin_get_status() -> i32 {
    match unsafe { STATE.as_ref() } {
        Some(s) if s.connected => 2, Some(_) => 0, None => 0,
    }
}

static mut ALLOC_BUF: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn plugin_alloc(size: i32) -> *mut u8 {
    unsafe { ALLOC_BUF = vec![0u8; size as usize]; ALLOC_BUF.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn plugin_free(_ptr: *mut u8, _size: i32) {}

fn log_host(level: i32, msg: &str) {
    unsafe { host_log(level, msg.as_ptr(), msg.len() as i32); }
}
