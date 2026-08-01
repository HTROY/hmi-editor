//! IEC 60870-5-104 Protocol Plugin (wasip2 component)
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../wit",
});

use crate::exports::hmi::plugin::lifecycle::Guest;
use hmi::plugin::events;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

async fn lm(l: u32, m: &str) {
    events::log(l, m.to_string()).await;
}

async fn rp(n: &str, v: f64, q: &str, ts: u64) {
    events::on_point(n.to_string(), v, q.to_string(), ts).await;
}

async fn rpt(dir: &str, p: &str, h: &str, s: &str) {
    events::on_packet(
        dir.to_string(),
        p.to_string(),
        h.to_string(),
        s.to_string(),
    )
    .await;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

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
    common_address: u16,
    #[serde(default)]
    points: Vec<Pc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PluginState {
    host: String,
    port: u16,
    common_address: u16,
    connected: bool,
    scan_count: u64,
    send_seq: u16,
    recv_seq: u16,
    points: Vec<Pc>,
}

static STATE: Mutex<Option<PluginState>> = Mutex::new(None);
static STREAM: Mutex<Option<TcpStream>> = Mutex::new(None);

fn build_startdt() -> Vec<u8> {
    vec![0x68, 0x04, 0x07, 0x00, 0x00, 0x00]
}
fn build_stopdt() -> Vec<u8> {
    vec![0x68, 0x04, 0x13, 0x00, 0x00, 0x00]
}
fn build_ti(s: &PluginState) -> Vec<u8> {
    let ss = s.send_seq;
    let rs = s.recv_seq;
    let c1 = ((ss << 1) & 0xfe) as u8;
    let c2 = (ss >> 7) as u8;
    let c3 = ((rs << 1) & 0xfe) as u8;
    let c4 = (rs >> 7) as u8;
    vec![
        0x68,
        14,
        c1,
        c2,
        c3,
        c4,
        0x64,
        0x01,
        0x06,
        0x00,
        (s.common_address >> 8) as u8,
        (s.common_address & 0xff) as u8,
        0x00,
        0x00,
        0x00,
        0x14,
    ]
}
fn build_cs(s: &PluginState) -> Vec<u8> {
    let ss = s.send_seq;
    let rs = s.recv_seq;
    let c1 = ((ss << 1) & 0xfe) as u8;
    let c2 = (ss >> 7) as u8;
    let c3 = ((rs << 1) & 0xfe) as u8;
    let c4 = (rs >> 7) as u8;
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let ms = ns.subsec_millis();
    vec![
        0x68,
        15,
        c1,
        c2,
        c3,
        c4,
        0x67,
        0x01,
        0x06,
        0x00,
        (s.common_address >> 8) as u8,
        (s.common_address & 0xff) as u8,
        0x00,
        0x00,
        0x00,
        (ms & 0xff) as u8,
        ((ms >> 8) & 0xff) as u8,
        0,
        0,
        0,
        0,
        1,
        1,
        22,
    ]
}
fn build_sel(s: &PluginState, ioa: u16, val: f64) -> Vec<u8> {
    let ss = s.send_seq.wrapping_add(1);
    let rs = s.recv_seq;
    let c1 = ((ss << 1) & 0xfe) as u8;
    let c2 = (ss >> 7) as u8;
    let c3 = ((rs << 1) & 0xfe) as u8;
    let c4 = (rs >> 7) as u8;
    let sco = if val != 0.0 { 0x81 } else { 0x80 };
    vec![
        0x68,
        15,
        c1,
        c2,
        c3,
        c4,
        0x2e,
        0x01,
        0x06,
        0x00,
        (s.common_address >> 8) as u8,
        (s.common_address & 0xff) as u8,
        (ioa >> 8) as u8,
        (ioa & 0xff) as u8,
        0x00,
        sco,
        0x00,
        0x00,
        0x00,
    ]
}

struct Plugin;

impl Guest for Plugin {
    async fn init(config_json: String) -> u32 {
        let cfg: PluginConfig = match serde_json::from_str(&config_json) {
            Ok(c) => c,
            Err(e) => {
                lm(3, &format!("bad config: {}", e)).await;
                return 1;
            }
        };
        lm(
            2,
            &format!(
                "IEC104 init: {}:{}, CASDU={}, {} pts",
                cfg.host,
                cfg.port,
                cfg.common_address,
                cfg.points.len()
            ),
        )
        .await;
        *STATE.lock().unwrap() = Some(PluginState {
            host: cfg.host,
            port: cfg.port,
            common_address: cfg.common_address,
            connected: false,
            scan_count: 0,
            send_seq: 0,
            recv_seq: 0,
            points: cfg.points,
        });
        0
    }

    async fn connect() -> u32 {
        let mut s = match STATE.lock().unwrap().as_ref() {
            Some(s) => s.clone(),
            None => {
                lm(1, "not initialized").await;
                return 1;
            }
        };
        lm(
            2,
            &format!("IEC104 connecting {}:{}...", s.host, s.port),
        )
        .await;
        let addr = format!("{}:{}", s.host, s.port);
        let stream = match TcpStream::connect_timeout(&addr.parse().unwrap_or_else(|_| "127.0.0.1:2404".parse().unwrap()), Duration::from_secs(5)) {
            Ok(st) => st,
            Err(e) => {
                lm(1, &format!("connect failed: {}", e)).await;
                s.connected = false;
                *STATE.lock().unwrap() = Some(s);
                return 1;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(3000)));
        let sd = build_startdt();
        let hex: String = sd
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        rpt("tx", "iec104", &hex, "TX: STARTDT").await;
        let mut stream = stream;
        let mut buf = [0u8; 4096];
        let _ = stream.write_all(&sd);
        let _ = stream.read(&mut buf);
        s.connected = true;
        *STREAM.lock().unwrap() = Some(stream);
        *STATE.lock().unwrap() = Some(s);
        0
    }

    async fn disconnect() -> u32 {
        let stopdt = build_stopdt();
        let mut guard = STREAM.lock().unwrap();
        if let Some(st) = guard.as_mut() {
            let _ = st.write_all(&stopdt);
        }
        *guard = None;
        drop(guard);
        if let Some(mut s) = STATE.lock().unwrap().as_ref().map(|s| s.clone()) {
            s.connected = false;
            *STATE.lock().unwrap() = Some(s);
        }
        0
    }

    async fn scan_points() -> u32 {
        let mut s = match STATE.lock().unwrap().as_ref() {
            Some(s) => s.clone(),
            None => return 1,
        };
        let mut stream_guard = STREAM.lock().unwrap();
        let stream = match stream_guard.as_mut() {
            Some(st) => st,
            None => return 1,
        };
        if !s.connected {
            return 1;
        }
        s.scan_count += 1;
        let now = now_ms();
        if s.scan_count % 10 == 1 {
            let _ = stream.write_all(&build_ti(&s));
        }
        if s.scan_count % 50 == 1 {
            let _ = stream.write_all(&build_cs(&s));
        }
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let points = s.points.clone();
        for pt in &points {
            rp(&pt.variable_id, 0.0, "good", now).await;
        }
        s.send_seq = s.send_seq.wrapping_add(1);
        *STATE.lock().unwrap() = Some(s);
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let mut s = match STATE.lock().unwrap().as_ref() {
            Some(s) => s.clone(),
            None => return 2,
        };
        let mut stream_guard = STREAM.lock().unwrap();
        let stream = match stream_guard.as_mut() {
            Some(st) => st,
            None => return 2,
        };
        if !s.connected {
            return 2;
        }
        let a = s
            .points
            .iter()
            .find(|p| p.variable_id == name)
            .and_then(|p| p.address.parse::<u16>().ok())
            .unwrap_or(0);
        let cmd = build_sel(&s, a, value);
        let _ = stream.write_all(&cmd);
        s.send_seq = s.send_seq.wrapping_add(1);
        *STATE.lock().unwrap() = Some(s);
        0
    }

    async fn get_name() -> String {
        "IEC 60870-5-104".to_string()
    }

    async fn get_status() -> u32 {
        match STATE.lock().unwrap().as_ref() {
            Some(s) if s.connected => 2,
            _ => 0,
        }
    }
}

export!(Plugin);
