//! Modbus TCP Protocol Plugin (wasip2 component)
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../wit",
});

use crate::exports::hmi::plugin::lifecycle::Guest;
use hmi::plugin::events;
use modbus::{tcp, Client, Coil};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pc {
    variable_id: String,
    address: String,
    var_type: String,
    #[serde(default)]
    data_type: String,
    #[serde(default)]
    byte_order: String,
    #[serde(default)]
    scale: f64,
    #[serde(default)]
    offset: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PluginConfig {
    host: String,
    port: u16,
    slave_id: u8,
    #[serde(default)]
    points: Vec<Pc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PluginState {
    host: String,
    port: u16,
    slave_id: u8,
    connected: bool,
    scan_count: u64,
    points: Vec<Pc>,
}

static STATE: Mutex<Option<PluginState>> = Mutex::new(None);
static STREAM: Mutex<Option<tcp::Transport>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn split_addr(address: &str) -> Result<(&'static str, u16), String> {
    for prefix in ["coil:", "holding_register:", "input_register:", "discrete_input:"] {
        if let Some(rest) = address.strip_prefix(prefix) {
            return rest
                .parse::<u16>()
                .map(|addr| (prefix, addr))
                .map_err(|e| format!("bad addr '{}': {}", address, e));
        }
    }
    Err(format!("unknown addr type: {}", address))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum WordOrder {
    Abcd,
    Badc,
    Cdab,
    Dcba,
}

fn word_order(byte_order: &str) -> WordOrder {
    match byte_order.trim().to_ascii_uppercase().as_str() {
        "BADC" => WordOrder::Badc,
        "CDAB" => WordOrder::Cdab,
        "DCBA" | "LITTLE" | "LITTLE_ENDIAN" => WordOrder::Dcba,
        _ => WordOrder::Abcd,
    }
}

fn is_32bit(dt: &str) -> bool {
    matches!(dt, "int32" | "uint32" | "float32")
}

fn decode_32(w0: u16, w1: u16, byte_order: &str) -> u32 {
    let b = [((w0 >> 8) as u8), (w0 as u8), ((w1 >> 8) as u8), (w1 as u8)];
    match word_order(byte_order) {
        WordOrder::Abcd => u32::from_be_bytes(b),
        WordOrder::Badc => u32::from_be_bytes([b[1], b[0], b[3], b[2]]),
        WordOrder::Cdab => u32::from_be_bytes([b[2], b[3], b[0], b[1]]),
        WordOrder::Dcba => u32::from_be_bytes([b[3], b[2], b[1], b[0]]),
    }
}

fn encode_32(value: u32, byte_order: &str) -> [u16; 2] {
    let b = value.to_be_bytes();
    let wire = match word_order(byte_order) {
        WordOrder::Abcd => b,
        WordOrder::Badc => [b[1], b[0], b[3], b[2]],
        WordOrder::Cdab => [b[2], b[3], b[0], b[1]],
        WordOrder::Dcba => [b[3], b[2], b[1], b[0]],
    };
    [
        u16::from_be_bytes([wire[0], wire[1]]),
        u16::from_be_bytes([wire[2], wire[3]]),
    ]
}

fn decode_value(dt: &str, byte_order: &str, w0: u16, w1: u16) -> f64 {
    match dt {
        "bool" => {
            if w0 != 0 {
                1.0
            } else {
                0.0
            }
        }
        "int16" => w0 as i16 as f64,
        "int32" => decode_32(w0, w1, byte_order) as i32 as f64,
        "uint32" => decode_32(w0, w1, byte_order) as f64,
        "float32" => f32::from_bits(decode_32(w0, w1, byte_order)) as f64,
        _ => w0 as f64,
    }
}

fn encode_value(dt: &str, byte_order: &str, value: f64) -> Vec<u16> {
    match dt {
        "int16" => vec![(value as i16) as u16],
        "int32" => encode_32((value as i32) as u32, byte_order).to_vec(),
        "uint32" => encode_32(value as u32, byte_order).to_vec(),
        "float32" => encode_32((value as f32).to_bits(), byte_order).to_vec(),
        _ => vec![value as u16],
    }
}

struct Plugin;

impl Guest for Plugin {
    async fn init(config_json: String) -> u32 {
        let c: PluginConfig = match serde_json::from_str(&config_json) {
            Ok(c) => c,
            Err(e) => {
                events::log(1, format!("modbus init err: {}", e)).await;
                return 1;
            }
        };
        events::log(
            2,
            format!(
                "Modbus TCP init: {}:{}, slave={}, {} pts",
                c.host,
                c.port,
                c.slave_id,
                c.points.len()
            ),
        )
        .await;
        *STATE.lock().unwrap() = Some(PluginState {
            host: c.host,
            port: c.port,
            slave_id: c.slave_id,
            connected: false,
            scan_count: 0,
            points: c.points,
        });
        0
    }

    async fn connect() -> u32 {
        let s = match STATE.lock().unwrap().as_ref() {
            Some(s) => s.clone(),
            None => return 1,
        };
        events::log(2, format!("Modbus TCP connecting {}:{}...", s.host, s.port)).await;
        let cfg = tcp::Config {
            tcp_port: s.port,
            tcp_connect_timeout: Some(Duration::from_secs(5)),
            tcp_read_timeout: Some(Duration::from_millis(2000)),
            tcp_write_timeout: Some(Duration::from_millis(2000)),
            modbus_uid: s.slave_id,
            ..Default::default()
        };
        match tcp::Transport::new_with_cfg(&s.host, cfg) {
            Ok(t) => {
                *STREAM.lock().unwrap() = Some(t);
                if let Some(st) = STATE.lock().unwrap().as_mut() {
                    st.connected = true;
                }
                events::log(2, "connected".to_string()).await;
                0
            }
            Err(e) => {
                events::log(1, format!("connect failed: {}", e)).await;
                1
            }
        }
    }

    async fn disconnect() -> u32 {
        if let Some(mut t) = STREAM.lock().unwrap().take() {
            let _ = t.close();
        }
        if let Some(st) = STATE.lock().unwrap().as_mut() {
            st.connected = false;
        }
        0
    }

    async fn scan_points() -> u32 {
        let mut state = STATE.lock().unwrap();
        let s = match state.as_mut() {
            Some(s) => s,
            None => return 1,
        };
        if !s.connected {
            return 1;
        }
        let mut stream_guard = STREAM.lock().unwrap();
        let stream = match stream_guard.as_mut() {
            Some(stream) => stream,
            None => return 1,
        };
        s.scan_count += 1;
        let now = now_ms();
        let points = s.points.clone();
        for pt in &points {
            match mb_read(stream, pt).await {
                Ok(v) => {
                    events::on_point(pt.variable_id.clone(), v, "good".to_string(), now).await;
                }
                Err(e) => {
                    events::on_point(pt.variable_id.clone(), 0.0, "bad".to_string(), now).await;
                    events::log(1, e).await;
                }
            }
        }
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let s = match STATE.lock().unwrap().clone() {
            Some(s) => s,
            None => return 1,
        };
        if !s.connected {
            return 2;
        }
        let pt = match s.points.iter().find(|p| p.variable_id == name).cloned() {
            Some(pt) => pt,
            None => return 3,
        };
        let mut stream_guard = STREAM.lock().unwrap();
        let stream = match stream_guard.as_mut() {
            Some(stream) => stream,
            None => return 2,
        };
        let result = if let Some(rest) = pt.address.strip_prefix("coil:") {
            let addr = match rest.parse::<u16>() {
                Ok(a) => a,
                Err(_) => return 3,
            };
            let on = value != 0.0;
            events::on_packet(
                "tx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("WR COIL addr={} val={}", addr, if on { 1 } else { 0 }),
            )
            .await;
            stream.write_single_coil(addr, Coil::from(on))
        } else if let Some(rest) = pt.address.strip_prefix("holding_register:") {
            let addr = match rest.parse::<u16>() {
                Ok(a) => a,
                Err(_) => return 3,
            };
            let vals = encode_value(&pt.data_type, &pt.byte_order, value);
            if vals.len() == 1 {
                events::on_packet(
                    "tx".to_string(),
                    "modbus".to_string(),
                    String::new(),
                    format!("WR HREG addr={} val=0x{:04x}", addr, vals[0]),
                )
                .await;
                stream.write_single_register(addr, vals[0])
            } else {
                events::on_packet(
                    "tx".to_string(),
                    "modbus".to_string(),
                    String::new(),
                    format!("WR HREG32 addr={} val={:04x} {:04x}", addr, vals[0], vals[1]),
                )
                .await;
                stream.write_multiple_registers(addr, &vals)
            }
        } else {
            return 3;
        };
        match result {
            Ok(_) => {
                events::log(2, format!("write {}={} done", name, value)).await;
                0
            }
            Err(e) => {
                events::log(1, format!("write {} failed: {}", name, e)).await;
                4
            }
        }
    }

    async fn get_name() -> String {
        "Modbus TCP".to_string()
    }

    async fn get_status() -> u32 {
        match STATE.lock().unwrap().as_ref() {
            Some(s) if s.connected => 2,
            _ => 0,
        }
    }
}

export!(Plugin);

async fn mb_read(stream: &mut tcp::Transport, pt: &Pc) -> Result<f64, String> {
    let (prefix, addr) = split_addr(&pt.address)?;
    match prefix {
        "coil:" => {
            events::on_packet(
                "tx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("RD_COIL addr={} count=1", addr),
            )
            .await;
            let coils = stream.read_coils(addr, 1).map_err(|e| e.to_string())?;
            let bit = coils.first() == Some(&Coil::On);
            events::on_packet(
                "rx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("resp: {}", if bit { "On" } else { "Off" }),
            )
            .await;
            Ok(if bit { 1.0 } else { 0.0 })
        }
        "discrete_input:" => {
            events::on_packet(
                "tx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("RD_DIN addr={} count=1", addr),
            )
            .await;
            let coils = stream
                .read_discrete_inputs(addr, 1)
                .map_err(|e| e.to_string())?;
            let bit = coils.first() == Some(&Coil::On);
            events::on_packet(
                "rx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("resp: {}", if bit { "On" } else { "Off" }),
            )
            .await;
            Ok(if bit { 1.0 } else { 0.0 })
        }
        "holding_register:" | "input_register:" => {
            let count = if is_32bit(&pt.data_type) { 2 } else { 1 };
            let fc_name = if prefix == "holding_register:" {
                "RD_HREG"
            } else {
                "RD_IREG"
            };
            events::on_packet(
                "tx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("{} addr={} count={}", fc_name, addr, count),
            )
            .await;
            let regs = if prefix == "holding_register:" {
                stream
                    .read_holding_registers(addr, count)
                    .map_err(|e| e.to_string())?
            } else {
                stream
                    .read_input_registers(addr, count)
                    .map_err(|e| e.to_string())?
            };
            if regs.len() < count as usize {
                return Err("short response".to_string());
            }
            let w0 = regs[0];
            let w1 = if count == 2 { regs[1] } else { 0 };
            let value = decode_value(&pt.data_type, &pt.byte_order, w0, w1);
            events::on_packet(
                "rx".to_string(),
                "modbus".to_string(),
                String::new(),
                format!("resp: regs=[{:04x} {:04x}]", w0, w1),
            )
            .await;
            Ok(value * pt.scale + pt.offset)
        }
        _ => Err(format!("unknown addr type: {}", pt.address)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_32_abcd() {
        assert_eq!(decode_32(0x1234, 0x5678, ""), 0x12345678);
        assert_eq!(decode_32(0x1234, 0x5678, "ABCD"), 0x12345678);
    }

    #[test]
    fn decode_32_badc() {
        assert_eq!(decode_32(0x1234, 0x5678, "BADC"), 0x34127856);
    }

    #[test]
    fn decode_32_cdab() {
        assert_eq!(decode_32(0x1234, 0x5678, "CDAB"), 0x56781234);
    }

    #[test]
    fn decode_32_dcba() {
        assert_eq!(decode_32(0x1234, 0x5678, "DCBA"), 0x78563412);
        assert_eq!(decode_32(0x1234, 0x5678, "little"), 0x78563412);
    }

    #[test]
    fn encode_32_roundtrip() {
        for order in ["", "ABCD", "BADC", "CDAB", "DCBA"] {
            let [w0, w1] = encode_32(0xdead_beef, order);
            assert_eq!(decode_32(w0, w1, order), 0xdead_beef);
        }
    }

    #[test]
    fn decode_value_types() {
        assert_eq!(decode_value("uint16", "", 0x000a, 0), 10.0);
        assert_eq!(decode_value("int16", "", 0x8000, 0), -32768.0);
        assert_eq!(decode_value("bool", "", 0x0001, 0), 1.0);
        assert_eq!(decode_value("bool", "", 0x0000, 0), 0.0);
        assert_eq!(decode_value("uint32", "", 0x0001, 0x0000), 0x0001_0000 as f64);
        assert_eq!(decode_value("int32", "", 0xffff, 0xffff), -1.0);
        assert_eq!(decode_value("float32", "", 0x3fc0, 0x0000), 1.5);
    }

    #[test]
    fn encode_value_types() {
        assert_eq!(encode_value("uint16", "", 42.0), vec![42]);
        assert_eq!(encode_value("int16", "", -1.0), vec![0xffff]);
        assert_eq!(encode_value("uint32", "", 0x12345678 as f64), vec![0x1234, 0x5678]);
        assert_eq!(encode_value("float32", "", 1.5), vec![0x3fc0, 0x0000]);
    }

    #[test]
    fn split_addr_cases() {
        assert_eq!(split_addr("coil:10").unwrap(), ("coil:", 10));
        assert_eq!(
            split_addr("holding_register:2").unwrap(),
            ("holding_register:", 2)
        );
        assert_eq!(split_addr("input_register:3").unwrap(), ("input_register:", 3));
        assert_eq!(split_addr("discrete_input:4").unwrap(), ("discrete_input:", 4));
        assert!(split_addr("blob:1").is_err());
        assert!(split_addr("coil:xx").is_err());
    }

    #[test]
    fn is_32bit_types() {
        assert!(is_32bit("int32"));
        assert!(is_32bit("uint32"));
        assert!(is_32bit("float32"));
        assert!(!is_32bit("uint16"));
        assert!(!is_32bit("bool"));
        assert!(!is_32bit(""));
    }
}
