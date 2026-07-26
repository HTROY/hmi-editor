use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use extism::*;
use tokio::sync::mpsc;

use super::interface::PluginInstance;
use crate::monitor::collector::MonitorCollector;
use crate::point::types::PointValue;

#[derive(Default)]
pub struct NetworkState { next_id: i32, tcp: HashMap<i32, TcpStream>, udp: HashMap<i32, UdpSocket> }
impl NetworkState {
    fn alloc_tcp(&mut self, s: TcpStream) -> i32 { let id=self.next_id; self.next_id+=1; self.tcp.insert(id,s); id }
    fn alloc_udp(&mut self, s: UdpSocket) -> i32 { let id=self.next_id; self.next_id+=1; self.udp.insert(id,s); id }
}

pub struct HostData {
    pub point_tx: mpsc::UnboundedSender<PointValue>,
    pub monitor: Arc<MonitorCollector>,
    pub plugin_name: String,
    pub network: Mutex<NetworkState>,
}

pub struct PluginHost;
impl PluginHost {
    pub fn new() -> anyhow::Result<Self> { Ok(Self) }
    pub fn load_plugin(&self, wasm_path: &str, point_tx: mpsc::UnboundedSender<PointValue>, monitor: Arc<MonitorCollector>, plugin_name: &str) -> anyhow::Result<PluginInstance> {
        let wasm = Wasm::file(wasm_path);
        let manifest = Manifest::new([wasm]);
        let hd = Arc::new(HostData { point_tx, monitor, plugin_name: plugin_name.to_string(), network: Mutex::new(NetworkState::default()) });
        let functions = build_host_functions(hd.clone());
        let plugin = Plugin::new(&manifest, functions, true).map_err(|e| anyhow::anyhow!("Failed to create Extism plugin '{}': {}", plugin_name, e))?;
        PluginInstance::new(plugin)
    }
}

fn read_plugin_str(plugin: &mut CurrentPlugin, offset: i64) -> String {
    if offset <= 0 { return String::new(); }
    if let Some(handle) = plugin.memory_handle(offset as u64) {
        if let Ok(bytes) = plugin.memory_bytes(handle) {
            return String::from_utf8_lossy(bytes).to_string();
        }
    }
    String::new()
}

fn read_plugin_bytes(plugin: &mut CurrentPlugin, offset: i64) -> Vec<u8> {
    if offset <= 0 { return Vec::new(); }
    if let Some(handle) = plugin.memory_handle(offset as u64) {
        if let Ok(bytes) = plugin.memory_bytes(handle) {
            return bytes.to_vec();
        }
    }
    Vec::new()
}

fn extract_hex(msg: &str) -> &str {
    if let Some(p) = msg.find(": ") { let r=&msg[p+2..]; if r.chars().all(|c| c.is_ascii_hexdigit()||c==' ')&&r.len()>2 { return r; } }
    msg
}

fn build_host_functions(data: Arc<HostData>) -> Vec<Function> {
    let mut f = Vec::new();

    // host_now_ms
    {
        let d = data.clone();
        f.push(Function::new(
            "host_now_ms",
            [],
            [ValType::I64],
            UserData::new(d),
            |_p, _i, o, _u| {
                o[0] = Val::I64(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64);
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_log
    {
        let d = data.clone();
        f.push(Function::new(
            "host_log",
            [ValType::I64, ValType::I64],
            [],
            UserData::new(d),
            |p, i, _o, u| {
                let lv = i[0].unwrap_i64() as i32;
                if lv < 0 || lv > 4 { return Ok(()); }
                let msg = read_plugin_str(p, i[1].unwrap_i64());
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                let pn = inner.plugin_name.clone();
                match lv {
                    0 => log::error!("[{}] {}", pn, msg),
                    1 => log::warn!("[{}] {}", pn, msg),
                    2 => log::info!("[{}] {}", pn, msg),
                    _ => log::debug!("[{}] {}", pn, msg),
                }
                if msg.contains("TX:") || msg.contains("tx:") {
                    inner.monitor.log_packet(&pn, "tx", &pn, extract_hex(&msg), &msg);
                } else if msg.contains("RX:") || msg.contains("rx:") {
                    inner.monitor.log_packet(&pn, "rx", &pn, extract_hex(&msg), &msg);
                }
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_on_point
    {
        let d = data.clone();
        f.push(Function::new(
            "host_on_point",
            [ValType::I64, ValType::F64, ValType::I64, ValType::I64],
            [],
            UserData::new(d),
            |p, i, _o, u| {
                let name = read_plugin_str(p, i[0].unwrap_i64());
                if name.is_empty() { return Ok(()); }
                let v = i[1].unwrap_f64();
                let q = read_plugin_str(p, i[2].unwrap_i64());
                let qs = if q.is_empty() { "good" } else { &q };
                let ts = i[3].unwrap_i64() as u64;
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                let pv = PointValue::new(&name, v, qs, ts);
                inner.monitor.update_point_value(&inner.plugin_name, &pv);
                let _ = inner.point_tx.send(pv);
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_on_packet
    {
        let d = data.clone();
        f.push(Function::new(
            "host_on_packet",
            [ValType::I64, ValType::I64, ValType::I64, ValType::I64],
            [],
            UserData::new(d),
            |p, i, _o, u| {
                let dir = read_plugin_str(p, i[0].unwrap_i64());
                let proto = read_plugin_str(p, i[1].unwrap_i64());
                let hex = read_plugin_str(p, i[2].unwrap_i64());
                let sum = read_plugin_str(p, i[3].unwrap_i64());
                if !hex.is_empty() {
                    let g = u.get().unwrap();
                    let inner = g.lock().unwrap();
                    inner.monitor.log_packet(&inner.plugin_name, &dir, &proto, &hex, &sum);
                }
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_tcp_connect
    {
        let d = data.clone();
        f.push(Function::new(
            "host_tcp_connect",
            [ValType::I64, ValType::I64],
            [ValType::I32],
            UserData::new(d),
            |p, i, o, u| {
                let host = read_plugin_str(p, i[0].unwrap_i64());
                let port = i[1].unwrap_i64() as u16;
                let addr = format!("{}:{}", host, port);
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                match TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_secs(5)) {
                    Ok(s) => {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(100)));
                        let id = inner.network.lock().unwrap().alloc_tcp(s);
                        o[0] = Val::I32(id);
                    }
                    Err(e) => {
                        log::warn!("[{}] tcp connect {}: {}", inner.plugin_name, addr, e);
                        o[0] = Val::I32(-1);
                    }
                }
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_tcp_send
    {
        let d = data.clone();
        f.push(Function::new(
            "host_tcp_send",
            [ValType::I64, ValType::I64],
            [ValType::I32],
            UserData::new(d),
            |p, i, o, u| {
                let sid = i[0].unwrap_i64() as i32;
                let bytes = read_plugin_bytes(p, i[1].unwrap_i64());
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                let mut net = inner.network.lock().unwrap();
                let sent = match net.tcp.get_mut(&sid) {
                    Some(s) => match s.write(&bytes) {
                        Ok(n) => n as i32,
                        Err(e) => {
                            log::warn!("[{}] tcp send fd={}: {}", inner.plugin_name, sid, e);
                            -1
                        }
                    },
                    None => -1,
                };
                o[0] = Val::I32(sent);
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_tcp_recv - returns I64 offset of allocated buffer (0=timeout, -1=error, -2=closed)
    {
        let d = data.clone();
        f.push(Function::new(
            "host_tcp_recv",
            [ValType::I64, ValType::I64],
            [ValType::I64],
            UserData::new(d),
            |p, i, o, u| {
                let sid = i[0].unwrap_i64() as i32;
                let to = i[1].unwrap_i64() as u64;
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                let mut net = inner.network.lock().unwrap();
                let r: i64 = match net.tcp.get_mut(&sid) {
                    Some(s) => {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(to)));
                        let mut buf = vec![0u8; 4096];
                        match s.read(&mut buf) {
                            Ok(0) => -2i64,
                            Ok(n) => {
                                match p.memory_alloc(n as u64) {
                                    Ok(handle) => {
                                        if let Ok(dst) = p.memory_bytes_mut(handle) {
                                            dst[..n].copy_from_slice(&buf[..n]);
                                        }
                                        handle.offset as i64
                                    }
                                    Err(_) => -1i64,
                                }
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut => 0i64,
                            Err(e) => {
                                log::warn!("[{}] tcp recv fd={}: {}", inner.plugin_name, sid, e);
                                -1i64
                            }
                        }
                    }
                    None => -1i64,
                };
                o[0] = Val::I64(r);
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_tcp_close
    {
        let d = data.clone();
        f.push(Function::new(
            "host_tcp_close",
            [ValType::I64],
            [],
            UserData::new(d),
            |_p, i, _o, u| {
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                inner.network.lock().unwrap().tcp.remove(&(i[0].unwrap_i64() as i32));
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_udp_bind
    {
        let d = data.clone();
        f.push(Function::new(
            "host_udp_bind",
            [ValType::I64],
            [ValType::I32],
            UserData::new(d),
            |_p, i, o, u| {
                let port = i[0].unwrap_i64() as u16;
                let addr = format!("0.0.0.0:{}", port);
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                match UdpSocket::bind(&addr) {
                    Ok(s) => {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(100)));
                        let id = inner.network.lock().unwrap().alloc_udp(s);
                        o[0] = Val::I32(id);
                    }
                    Err(e) => {
                        log::warn!("[{}] udp bind {}: {}", inner.plugin_name, addr, e);
                        o[0] = Val::I32(-1);
                    }
                }
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_udp_send
    {
        let d = data.clone();
        f.push(Function::new(
            "host_udp_send",
            [ValType::I64, ValType::I64, ValType::I64, ValType::I64],
            [ValType::I32],
            UserData::new(d),
            |p, i, o, u| {
                let sid = i[0].unwrap_i64() as i32;
                let host = read_plugin_str(p, i[1].unwrap_i64());
                let port = i[2].unwrap_i64() as u16;
                let bytes = read_plugin_bytes(p, i[3].unwrap_i64());
                let addr = format!("{}:{}", host, port);
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                let mut net = inner.network.lock().unwrap();
                let sent = match net.udp.get_mut(&sid) {
                    Some(s) => s.send_to(&bytes, &addr).map(|n| n as i32).unwrap_or(-1),
                    None => -1,
                };
                o[0] = Val::I32(sent);
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_udp_recv - returns I64 offset of allocated buffer (0=timeout, -1=error)
    {
        let d = data.clone();
        f.push(Function::new(
            "host_udp_recv",
            [ValType::I64, ValType::I64],
            [ValType::I64],
            UserData::new(d),
            |p, i, o, u| {
                let sid = i[0].unwrap_i64() as i32;
                let to = i[1].unwrap_i64() as u64;
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                let mut net = inner.network.lock().unwrap();
                let r: i64 = match net.udp.get_mut(&sid) {
                    Some(s) => {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(to)));
                        let mut buf = vec![0u8; 4096];
                        match s.recv_from(&mut buf) {
                            Ok((n, _)) => {
                                match p.memory_alloc(n as u64) {
                                    Ok(handle) => {
                                        if let Ok(dst) = p.memory_bytes_mut(handle) {
                                            dst[..n].copy_from_slice(&buf[..n]);
                                        }
                                        handle.offset as i64
                                    }
                                    Err(_) => -1i64,
                                }
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut => 0i64,
                            Err(_) => -1i64,
                        }
                    }
                    None => -1i64,
                };
                o[0] = Val::I64(r);
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    // host_udp_close
    {
        let d = data.clone();
        f.push(Function::new(
            "host_udp_close",
            [ValType::I64],
            [],
            UserData::new(d),
            |_p, i, _o, u| {
                let g = u.get().unwrap();
                let inner = g.lock().unwrap();
                inner.network.lock().unwrap().udp.remove(&(i[0].unwrap_i64() as i32));
                Ok(())
            },
        ).with_namespace("hmi"));
    }

    f
}
