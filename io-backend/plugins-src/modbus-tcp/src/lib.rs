//! Modbus TCP Protocol Plugin (WASM)
//!
//! Simulates Modbus TCP communication with periodic scan.
//! In real deployment, this would use host-provided TCP functions
//! to communicate with actual Modbus TCP devices.
//!
//! Protocol: Reads coils (DI) and holding registers (AI) from a Modbus slave.

use serde::Deserialize;
use std::collections::HashMap;

// ---- Host imports ----
extern "C" {
    fn host_on_point(
        name_ptr: *const u8,
        name_len: i32,
        value: f64,
        quality_ptr: *const u8,
        quality_len: i32,
        timestamp: i64,
    );
    fn host_log(level: i32, msg_ptr: *const u8, msg_len: i32);
    fn host_now_ms() -> i64;
}

// ---- Plugin state ----
static mut STATE: Option<PluginState> = None;

struct PluginState {
    host: String,
    port: u16,
    slave_id: u8,
    connected: bool,
    scan_count: u64,
}

#[derive(Deserialize)]
struct PluginConfig {
    host: String,
    port: u16,
    slave_id: u8,
}

// ---- Plugin exports ----

#[no_mangle]
pub extern "C" fn plugin_init(config_ptr: *const u8, config_len: i32) -> i32 {
    let config_str = unsafe {
        let slice = std::slice::from_raw_parts(config_ptr, config_len as usize);
        match std::str::from_utf8(slice) {
            Ok(s) => s,
            Err(_) => return 1,
        }
    };

    let config: PluginConfig = match serde_json::from_str(config_str) {
        Ok(c) => c,
        Err(_) => {
            log_host(0, "Failed to parse Modbus config");
            return 2;
        }
    };

    let state = PluginState {
        host: config.host,
        port: config.port,
        slave_id: config.slave_id,
        connected: false,
        scan_count: 0,
    };

    log_host(2, &format!(
        "Modbus TCP plugin init: {}:{}, slave={}",
        state.host, state.port, state.slave_id
    ));

    unsafe { STATE = Some(state); }
    0
}

#[no_mangle]
pub extern "C" fn plugin_connect() -> i32 {
    let state = unsafe { STATE.as_mut().expect("plugin not initialized") };
    log_host(2, &format!(
        "Modbus TCP connecting to {}:{}...",
        state.host, state.port
    ));
    state.connected = true;
    log_host(2, "Modbus TCP connected (simulated)");
    0
}

#[no_mangle]
pub extern "C" fn plugin_disconnect() -> i32 {
    let state = unsafe { STATE.as_mut().expect("plugin not initialized") };
    state.connected = false;
    log_host(2, "Modbus TCP disconnected");
    0
}

#[no_mangle]
pub extern "C" fn plugin_scan_points() -> i32 {
    let state = unsafe { STATE.as_mut().expect("plugin not initialized") };
    if !state.connected {
        return 1;
    }
    state.scan_count += 1;
    let now = unsafe { host_now_ms() };

    // Simulate reading Modbus registers
    let points: Vec<(&str, f64)> = vec![
        ("coil:0", if state.scan_count % 3 == 0 { 1.0 } else { 0.0 }),
        ("coil:1", if state.scan_count % 5 == 0 { 1.0 } else { 0.0 }),
        ("coil:10", if state.scan_count % 7 == 0 { 1.0 } else { 0.0 }),
        ("holding_register:0", 800.0 + (state.scan_count as f64 * 0.1 % 400.0) * 10.0),
        ("holding_register:2", 3950.0 + (state.scan_count as f64 % 150.0) * 10.0),
        ("holding_register:4", 1800.0 + (state.scan_count as f64 * 0.5 % 1200.0) * 10.0),
        ("holding_register:6", 250.0 + (state.scan_count as f64 % 50.0) * 10.0),
    ];

    let quality = b"good";
    for (addr, val) in &points {
        unsafe {
            host_on_point(
                addr.as_ptr(),
                addr.len() as i32,
                *val,
                quality.as_ptr(),
                quality.len() as i32,
                now,
            );
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn plugin_write_point(
    name_ptr: *const u8,
    name_len: i32,
    value_ptr: *const u8,
    value_len: i32,
) -> i32 {
    let name = unsafe {
        let slice = std::slice::from_raw_parts(name_ptr, name_len as usize);
        String::from_utf8_lossy(slice).to_string()
    };
    let value_str = unsafe {
        let slice = std::slice::from_raw_parts(value_ptr, value_len as usize);
        String::from_utf8_lossy(slice).to_string()
    };
    let value: f64 = match value_str.parse() {
        Ok(v) => v,
        Err(_) => return 1,
    };

    log_host(2, &format!("Modbus write: {} = {}", name, value));

    let now = unsafe { host_now_ms() };
    let quality = b"good";
    unsafe {
        host_on_point(name.as_ptr(), name.len() as i32, value, quality.as_ptr(), quality.len() as i32, now);
    }
    0
}

#[no_mangle]
pub extern "C" fn plugin_get_name(ptr: *mut u8, max_len: i32) -> i32 {
    let name = b"Modbus TCP";
    let len = name.len().min(max_len as usize);
    unsafe { std::ptr::copy_nonoverlapping(name.as_ptr(), ptr, len); }
    len as i32
}

#[no_mangle]
pub extern "C" fn plugin_get_status() -> i32 {
    let state = unsafe { STATE.as_ref() };
    match state {
        Some(s) if s.connected => 2,
        Some(_) => 0,
        None => 0,
    }
}

// ---- Memory management ----

static mut ALLOC_BUF: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn plugin_alloc(size: i32) -> *mut u8 {
    unsafe {
        ALLOC_BUF = vec![0u8; size as usize];
        ALLOC_BUF.as_mut_ptr()
    }
}

#[no_mangle]
pub extern "C" fn plugin_free(_ptr: *mut u8, _size: i32) {}

fn log_host(level: i32, msg: &str) {
    unsafe { host_log(level, msg.as_ptr(), msg.len() as i32); }
}
