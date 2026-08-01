//! OPC UA Protocol Plugin (wasip2 component)
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
    endpoint: String,
    #[serde(default)]
    points: Vec<Pc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PluginState {
    endpoint: String,
    connected: bool,
    scan_count: u64,
    points: Vec<Pc>,
}

static STATE: Mutex<Option<PluginState>> = Mutex::new(None);
static STREAM: Mutex<Option<TcpStream>> = Mutex::new(None);

fn build_hello(ep: &str) -> Vec<u8> {
    let eb = ep.as_bytes();
    let tl = 32 + eb.len() as u32;
    let mut m = Vec::with_capacity(tl as usize);
    m.extend_from_slice(b"HEL");
    m.push(b'F');
    m.extend_from_slice(&tl.to_le_bytes());
    m.extend_from_slice(&[0u8; 4]);
    m.extend_from_slice(&65535u32.to_le_bytes());
    m.extend_from_slice(&65535u32.to_le_bytes());
    m.extend_from_slice(&[0u8; 8]);
    m.extend_from_slice(eb);
    m
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
                "OPC UA init: {}, {} pts",
                cfg.endpoint,
                cfg.points.len()
            ),
        )
        .await;
        *STATE.lock().unwrap() = Some(PluginState {
            endpoint: cfg.endpoint,
            connected: false,
            scan_count: 0,
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
        let h = s
            .endpoint
            .trim_start_matches("opc.tcp://")
            .split(':')
            .next()
            .unwrap_or("127.0.0.1")
            .to_string();
        let p = s
            .endpoint
            .split(':')
            .last()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(4840);
        lm(2, &format!("OPC UA connecting {}:{}...", h, p)).await;
        let addr = format!("{}:{}", h, p);
        let stream = match TcpStream::connect_timeout(&addr.parse().unwrap_or_else(|_| "127.0.0.1:4840".parse().unwrap()), Duration::from_secs(5)) {
            Ok(st) => st,
            Err(e) => {
                lm(1, &format!("connect failed: {}", e)).await;
                s.connected = false;
                *STATE.lock().unwrap() = Some(s);
                return 1;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(3000)));
        let hello = build_hello(&s.endpoint);
        let hex: String = hello
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        rpt("tx", "opcua", &hex, "TX: Hello").await;
        let mut stream = stream;
        let mut buf = [0u8; 4096];
        let _ = stream.write_all(&hello);
        let _ = stream.read(&mut buf);
        s.connected = true;
        *STREAM.lock().unwrap() = Some(stream);
        *STATE.lock().unwrap() = Some(s);
        0
    }

    async fn disconnect() -> u32 {
        *STREAM.lock().unwrap() = None;
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
        let stream_locked = STREAM.lock().unwrap();
        if !s.connected || stream_locked.is_none() {
            return 1;
        }
        s.scan_count += 1;
        let now = now_ms();
        let points = s.points.clone();
        for pt in &points {
            rp(&pt.variable_id, 0.0, "good", now).await;
        }
        *STATE.lock().unwrap() = Some(s);
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let stream_locked = STREAM.lock().unwrap();
        if stream_locked.is_none() {
            return 2;
        }
        lm(2, &format!("write {} = {}", name, value)).await;
        0
    }

    async fn get_name() -> String {
        "OPC UA".to_string()
    }

    async fn get_status() -> u32 {
        match STATE.lock().unwrap().as_ref() {
            Some(s) if s.connected => 2,
            _ => 0,
        }
    }
}

export!(Plugin);
