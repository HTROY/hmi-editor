//! OPC UA client plugin (wasip2 component), SecurityPolicy None.
//!
//! Hand-rolled binary protocol on top of the shared `ua-core` codec:
//! HEL/ACK handshake, OPN secure channel, CreateSession / ActivateSession
//! (anonymous or username/password), batched Read per scan, Write requests,
//! CloseSession + CloseSecureChannel on disconnect. MSG chunk reassembly
//! (C chunks accumulated until F) is supported on the receive path.
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../../wit",
});

use crate::exports::hmi::plugin::lifecycle::Guest;
use hmi::plugin::events;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sync_util::MutexExt;
use ua_core::{
    build_activate_session_body, build_close_channel_body, build_close_session_body,
    build_create_session_body, build_opn_body, build_read_body, build_write_body, now_unix_ms,
    parse_activate_session_body, parse_create_session_body, parse_hello_message, parse_opn_body,
    parse_read_body, parse_secure_message, parse_service_body, parse_write_body, status_quality,
    CreateSessionResult, IncomingMessage, NodeId, ReadValueId, VariantValue, WriteValue,
    ATTR_VALUE, ID_ACTIVATE_SESSION_RSP, ID_CLOSE_SECURE_CHANNEL_RSP, ID_CLOSE_SESSION_RSP,
    ID_CREATE_SESSION_RSP, ID_READ_RSP, ID_WRITE_RSP,
};

const READ_TIMEOUT_MS: u64 = 3_000;
const MAX_BUF: usize = 1 << 20;

async fn lm(l: u32, m: &str) {
    events::log(l, m.to_string()).await;
}

async fn rp(n: &str, v: f64, q: &str, ts: u64) {
    events::on_point(n.to_string(), v, q.to_string(), ts).await;
}

async fn rpt(dir: &str, p: &str, h: &str, s: &str) {
    events::on_packet(dir.to_string(), p.to_string(), h.to_string(), s.to_string()).await;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{:02X}", x))
        .collect::<Vec<_>>()
        .join(" ")
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
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    points: Vec<Pc>,
}

#[derive(Debug, Clone)]
struct PluginState {
    host: String,
    port: u16,
    endpoint: String,
    username: Option<String>,
    password: Option<String>,
    connected: bool,
    session_active: bool,
    channel_id: u32,
    token_id: u32,
    seq: u32,
    handle: u32,
    auth_token: NodeId,
    points: Vec<Pc>,
}

static STATE: Mutex<Option<PluginState>> = Mutex::new(None);
static STREAM: Mutex<Option<TcpStream>> = Mutex::new(None);

/// Parse `opc.tcp://host[:port]` into (host, port).
fn parse_endpoint(endpoint: &str) -> Result<(String, u16), String> {
    let rest = endpoint
        .strip_prefix("opc.tcp://")
        .ok_or_else(|| format!("bad endpoint {}", endpoint))?;
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => {
            let port = p
                .parse::<u16>()
                .map_err(|_| format!("bad port in {}", endpoint))?;
            (h.to_string(), port)
        }
        None => (rest.to_string(), 4840),
    };
    if host.is_empty() {
        return Err(format!("empty host in {}", endpoint));
    }
    Ok((host, port))
}

fn build_hello(endpoint: &str) -> Vec<u8> {
    // HELLO: "HELF" + u32 size + 5 u32 params + endpointUrl without a length prefix.
    let mut v = Vec::with_capacity(28 + endpoint.len());
    v.extend_from_slice(b"HELF");
    v.extend_from_slice(&((28 + endpoint.len()) as u32).to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes()); // protocolVersion
    v.extend_from_slice(&65535u32.to_le_bytes()); // receiveBufferSize
    v.extend_from_slice(&65535u32.to_le_bytes()); // sendBufferSize
    v.extend_from_slice(&(MAX_BUF as u32).to_le_bytes()); // maxMessageSize
    v.extend_from_slice(&65535u32.to_le_bytes()); // maxChunkSize
    v.extend_from_slice(endpoint.as_bytes());
    v
}

/// Wrap a service body into a secure message frame.
fn wrap_secure(
    msg_type: &[u8; 3],
    channel_id: u32,
    token_id: u32,
    seq: u32,
    request_id: u32,
    body: &[u8],
) -> Vec<u8> {
    let mut v = Vec::with_capacity(24 + body.len());
    v.extend_from_slice(msg_type);
    v.push(b'F');
    v.extend_from_slice(&((24 + body.len()) as u32).to_le_bytes());
    v.extend_from_slice(&channel_id.to_le_bytes());
    v.extend_from_slice(&token_id.to_le_bytes());
    v.extend_from_slice(&seq.to_le_bytes());
    v.extend_from_slice(&request_id.to_le_bytes());
    v.extend_from_slice(body);
    v
}

/// Read until at least `n` bytes are available or the timeout fires.
fn read_more(stream: &mut TcpStream, buf: &mut Vec<u8>, n: usize) -> Result<(), String> {
    let mut chunk = [0u8; 8192];
    let deadline = now_ms() + READ_TIMEOUT_MS;
    while buf.len() < n && now_ms() < deadline {
        match stream.read(&mut chunk) {
            Ok(0) => return Err("server closed connection".to_string()),
            Ok(m) => buf.extend_from_slice(&chunk[..m]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => return Err(format!("read error: {}", e)),
        }
    }
    if buf.len() < n {
        return Err(format!(
            "timeout waiting for data (have {}, need {})",
            buf.len(),
            n
        ));
    }
    Ok(())
}

/// Pull one complete message from the stream, reassembling chunks.
fn read_message(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut parts: Vec<Vec<u8>> = Vec::new();
    loop {
        read_more(stream, &mut buf, 8)?;
        let msg_type = [buf[0], buf[1], buf[2]];
        let size = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
        if size < 8 {
            return Err(format!("bad message size {}", size));
        }
        read_more(stream, &mut buf, size)?;
        let msg: Vec<u8> = buf.drain(..size).collect();
        let is_secure = matches!(&msg_type, b"OPN" | b"MSG" | b"CLO");
        let chunk_type = msg.get(3).copied().unwrap_or(b'F');
        if !is_secure {
            // HEL/ACK/ERR complete messages are delivered as-is.
            return Ok(msg);
        }
        parts.push(msg);
        if chunk_type == b'F' {
            // Concatenate all chunk bodies (24-byte headers stripped later).
            let mut full = Vec::new();
            for p in &parts {
                if p.len() < 24 {
                    return Err("short secure chunk".to_string());
                }
                full.extend_from_slice(&p[24..]);
            }
            // Rebuild a single logical message header from the final chunk.
            let last = parts.last().unwrap();
            let mut out = Vec::with_capacity(24 + full.len());
            out.extend_from_slice(&last[..24]);
            out.extend_from_slice(&full);
            return Ok(out);
        }
        buf.clear();
    }
}

/// Parse a secure message and check the response type id.
async fn recv_service(
    stream: &mut TcpStream,
    token_id: u32,
    expected_tid: u32,
) -> Result<Vec<u8>, String> {
    loop {
        let msg = read_message(stream)?;
        let (tok, body) = parse_secure_message(&msg)?;
        if tok != token_id {
            lm(1, &format!("token mismatch: got {} want {}", tok, token_id)).await;
            return Err("token mismatch".to_string());
        }
        let (tid, rest) = parse_service_body(&body)?;
        if tid != expected_tid {
            lm(1, &format!("unexpected response type {}", tid)).await;
            return Err(format!("unexpected response type {}", tid));
        }
        return Ok(rest.to_vec());
    }
}

fn send_all(stream: &mut TcpStream, bytes: &[u8]) -> Result<(), String> {
    stream.write_all(bytes).map_err(|e| e.to_string())
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
        let (host, port) = match parse_endpoint(&cfg.endpoint) {
            Ok(hp) => hp,
            Err(e) => {
                lm(3, &e).await;
                return 1;
            }
        };
        lm(
            2,
            &format!(
                "OPC UA init: {}:{} ({}), auth={}, {} pts",
                host,
                port,
                cfg.endpoint,
                if cfg.username.is_some() {
                    "user"
                } else {
                    "anonymous"
                },
                cfg.points.len()
            ),
        )
        .await;
        *STATE.lock_recover() = Some(PluginState {
            host,
            port,
            endpoint: cfg.endpoint,
            username: cfg.username,
            password: cfg.password,
            connected: false,
            session_active: false,
            channel_id: 0,
            token_id: 0,
            seq: 0,
            handle: 0,
            auth_token: NodeId::null(),
            points: cfg.points,
        });
        0
    }

    async fn connect() -> u32 {
        let mut s = match STATE.lock_recover().as_ref() {
            Some(s) => s.clone(),
            None => {
                lm(1, "not initialized").await;
                return 1;
            }
        };
        s.seq = 0;
        s.handle = 0;
        s.channel_id = 0;
        s.token_id = 0;
        s.auth_token = NodeId::null();
        s.session_active = false;
        lm(2, &format!("OPC UA connecting {}:{}...", s.host, s.port)).await;

        let addr = format!("{}:{}", s.host, s.port);
        let stream = match TcpStream::connect_timeout(
            &addr
                .parse()
                .unwrap_or_else(|_| "127.0.0.1:4840".parse().unwrap()),
            Duration::from_secs(5),
        ) {
            Ok(st) => st,
            Err(e) => {
                lm(1, &format!("connect failed: {}", e)).await;
                s.connected = false;
                *STATE.lock_recover() = Some(s);
                return 1;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        *STREAM.lock_recover() = Some(stream);

        let mut guard = STREAM.lock_recover();
        let stream = guard.as_mut().unwrap();
        if let Err(e) = connect_handshake(stream, &mut s).await {
            lm(1, &format!("handshake failed: {}", e)).await;
            *guard = None;
            drop(guard);
            s.connected = false;
            *STATE.lock_recover() = Some(s);
            return 1;
        }
        s.connected = true;
        *STATE.lock_recover() = Some(s);
        lm(2, "OPC UA connected").await;
        0
    }

    async fn disconnect() -> u32 {
        let mut guard = STREAM.lock_recover();
        if let Some(st) = guard.as_mut() {
            let mut s = match STATE.lock_recover().as_ref() {
                Some(s) => s.clone(),
                None => return 0,
            };
            if s.connected {
                s.seq += 1;
                s.handle += 1;
                let hid = s.handle;
                // CloseSession then CloseSecureChannel; best effort.
                let body = build_close_session_body(now_unix_ms(), hid, &s.auth_token);
                let frame = wrap_secure(b"MSG", s.channel_id, s.token_id, s.seq, hid, &body);
                let _ = send_all(st, &frame);
                if let Ok(m) = read_message(st) {
                    if let Ok((_, b)) = parse_secure_message(&m) {
                        if let Ok((tid, _)) = parse_service_body(&b) {
                            lm(2, &format!("CloseSession ack tid={}", tid)).await;
                        }
                    }
                }
                s.seq += 1;
                s.handle += 1;
                let hid = s.handle;
                let body = build_close_channel_body(now_unix_ms(), hid);
                let frame = wrap_secure(b"CLO", s.channel_id, s.token_id, s.seq, hid, &body);
                let _ = send_all(st, &frame);
            }
            let _ = st.shutdown(std::net::Shutdown::Both);
        }
        *guard = None;
        drop(guard);
        if let Some(mut s) = STATE.lock_recover().as_ref().map(|s| s.clone()) {
            s.connected = false;
            s.session_active = false;
            *STATE.lock_recover() = Some(s);
        }
        0
    }

    async fn scan_points() -> u32 {
        let mut s = match STATE.lock_recover().as_ref() {
            Some(s) => s.clone(),
            None => return 1,
        };
        if !s.connected || !s.session_active {
            return 1;
        }
        let nodes: Vec<ReadValueId> = s
            .points
            .iter()
            .filter_map(|p| {
                NodeId::parse(&p.address).ok().map(|n| ReadValueId {
                    node: n,
                    attribute_id: ATTR_VALUE,
                })
            })
            .collect();
        if nodes.is_empty() {
            return 1;
        }
        let mut guard = STREAM.lock_recover();
        let stream = match guard.as_mut() {
            Some(st) => st,
            None => return 1,
        };
        s.seq += 1;
        s.handle += 1;
        let hid = s.handle;
        let body = build_read_body(now_unix_ms(), hid, &s.auth_token, &nodes);
        let frame = wrap_secure(b"MSG", s.channel_id, s.token_id, s.seq, hid, &body);
        let hexstr = hex(&frame);
        match send_all(stream, &frame) {
            Ok(_) => {
                rpt(
                    "tx",
                    "opc-ua",
                    &hexstr,
                    &format!("ReadRequest {} nodes", nodes.len()),
                )
                .await
            }
            Err(e) => {
                lm(1, &format!("read send failed: {}", e)).await;
                *guard = None;
                drop(guard);
                s.connected = false;
                *STATE.lock_recover() = Some(s);
                return 1;
            }
        }
        // Drain pending messages until our ReadResponse arrives.
        let mut reported = 0usize;
        let deadline = now_ms() + 10_000;
        while now_ms() < deadline {
            let msg = match read_message(stream) {
                Ok(m) => m,
                Err(e) => {
                    lm(2, &format!("read failed: {}", e)).await;
                    break;
                }
            };
            let (tok, body) = match parse_secure_message(&msg) {
                Ok(x) => x,
                Err(e) => {
                    lm(2, &format!("secure parse: {}", e)).await;
                    continue;
                }
            };
            if tok != s.token_id {
                continue;
            }
            let (tid, rest) = match parse_service_body(&body) {
                Ok(x) => x,
                Err(e) => {
                    lm(2, &format!("service parse: {}", e)).await;
                    continue;
                }
            };
            if tid == ID_READ_RSP {
                let dvs = match parse_read_body(&rest) {
                    Ok(d) => d,
                    Err(e) => {
                        lm(1, &format!("Read failed: {}", e)).await;
                        break;
                    }
                };
                for (i, dv) in dvs.iter().enumerate() {
                    if let Some(p) = s.points.get(i) {
                        let q = status_quality(dv.status);
                        let ts = now_ms();
                        match dv.value.as_ref().and_then(|v| v.as_f64()) {
                            Some(v) => {
                                rp(&p.variable_id, v * p.scale + p.offset, q, ts).await;
                                reported += 1;
                            }
                            None => {
                                rp(&p.variable_id, 0.0, "bad", ts).await;
                            }
                        }
                    }
                }
                break;
            }
            if tid == ID_CLOSE_SESSION_RSP || tid == ID_CLOSE_SECURE_CHANNEL_RSP {
                lm(2, "server closed session").await;
                break;
            }
        }
        lm(2, &format!("Read round-trip: {} point(s)", reported)).await;
        *STATE.lock_recover() = Some(s);
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let mut s = match STATE.lock_recover().as_ref() {
            Some(s) => s.clone(),
            None => return 2,
        };
        if !s.connected || !s.session_active {
            return 2;
        }
        let pt = match s.points.iter().find(|p| p.variable_id == name) {
            Some(p) => p.clone(),
            None => {
                lm(1, &format!("write: unknown point {}", name)).await;
                return 3;
            }
        };
        let node = match NodeId::parse(&pt.address) {
            Ok(n) => n,
            Err(e) => {
                lm(1, &format!("write: bad address {}: {}", pt.address, e)).await;
                return 3;
            }
        };
        let val = if pt.data_type.to_lowercase().contains("bool") {
            VariantValue::Boolean(value != 0.0)
        } else {
            VariantValue::Double(value)
        };
        let writes = vec![WriteValue {
            node,
            attribute_id: ATTR_VALUE,
            value: Some(val),
        }];
        let mut guard = STREAM.lock_recover();
        let stream = match guard.as_mut() {
            Some(st) => st,
            None => return 2,
        };
        s.seq += 1;
        s.handle += 1;
        let hid = s.handle;
        let body = build_write_body(now_unix_ms(), hid, &s.auth_token, &writes);
        let frame = wrap_secure(b"MSG", s.channel_id, s.token_id, s.seq, hid, &body);
        let hexstr = hex(&frame);
        if let Err(e) = send_all(stream, &frame) {
            lm(1, &format!("write send failed: {}", e)).await;
            *guard = None;
            drop(guard);
            s.connected = false;
            *STATE.lock_recover() = Some(s);
            return 2;
        }
        rpt("tx", "opc-ua", &hexstr, "WriteRequest").await;
        let mut status = 0u32;
        let deadline = now_ms() + 10_000;
        while now_ms() < deadline {
            let msg = match read_message(stream) {
                Ok(m) => m,
                Err(e) => {
                    lm(2, &format!("read failed: {}", e)).await;
                    return 2;
                }
            };
            let (_tok, body) = match parse_secure_message(&msg) {
                Ok(x) => x,
                Err(e) => {
                    lm(2, &format!("secure parse: {}", e)).await;
                    continue;
                }
            };
            let (tid, rest) = match parse_service_body(&body) {
                Ok(x) => x,
                Err(e) => {
                    lm(2, &format!("service parse: {}", e)).await;
                    continue;
                }
            };
            if tid == ID_WRITE_RSP {
                let codes = match parse_write_body(&rest) {
                    Ok(c) => c,
                    Err(e) => {
                        lm(1, &format!("Write failed: {}", e)).await;
                        break;
                    }
                };
                status = codes.first().copied().unwrap_or(0x8000_0000);
                break;
            }
            if tid == ID_READ_RSP {
                continue; // stale scan response
            }
        }
        if status == 0 {
            lm(2, &format!("write {} = {} ok", name, value)).await;
        } else {
            lm(2, &format!("write {} failed: 0x{:08x}", name, status)).await;
        }
        *STATE.lock_recover() = Some(s);
        if status == 0 {
            0
        } else {
            4
        }
    }

    async fn get_name() -> String {
        "OPC UA".to_string()
    }

    async fn get_status() -> u32 {
        match STATE.lock_recover().as_ref() {
            Some(s) if s.connected => 2,
            _ => 0,
        }
    }
}

/// HEL/ACK -> OPN -> CreateSession -> ActivateSession.
async fn connect_handshake(stream: &mut TcpStream, s: &mut PluginState) -> Result<(), String> {
    // 1) HEL
    let hello = build_hello(&s.endpoint);
    let hexstr = hex(&hello);
    send_all(stream, &hello)?;
    rpt("tx", "opc-ua", &hexstr, "HEL").await;
    let msg = read_message(stream)?;
    match parse_hello_message(&msg)? {
        IncomingMessage::Ack => rpt("rx", "opc-ua", &hex(&msg), "ACK").await,
        IncomingMessage::Err { code, reason } => {
            rpt("rx", "opc-ua", &hex(&msg), "ERR").await;
            return Err(format!("server ERR {}: {}", code, reason));
        }
        IncomingMessage::Secure { .. } => return Err("expected ACK".to_string()),
    }

    // 2) OPN
    s.seq += 1;
    s.handle += 1;
    let hid = s.handle;
    let body = build_opn_body(now_unix_ms(), hid);
    let frame = wrap_secure(b"OPN", 0, 0, s.seq, hid, &body);
    let hexstr = hex(&frame);
    send_all(stream, &frame)?;
    rpt("tx", "opc-ua", &hexstr, "OPN").await;
    let msg = read_message(stream)?;
    let (tok, body) = parse_secure_message(&msg)?;
    let (channel_id, _lifetime) = parse_opn_body(&body)?;
    rpt("rx", "opc-ua", &hex(&msg), "OPN rsp").await;
    s.channel_id = channel_id;
    s.token_id = tok;
    lm(2, &format!("OPN ok: channel={} token={}", channel_id, tok)).await;

    // 3) CreateSession
    s.seq += 1;
    s.handle += 1;
    let hid = s.handle;
    let body = build_create_session_body(now_unix_ms(), hid, &s.endpoint);
    let frame = wrap_secure(b"MSG", s.channel_id, s.token_id, s.seq, hid, &body);
    let hexstr = hex(&frame);
    send_all(stream, &frame)?;
    rpt("tx", "opc-ua", &hexstr, "CreateSession").await;
    let rest = recv_service(stream, s.token_id, ID_CREATE_SESSION_RSP).await?;
    let CreateSessionResult {
        auth_token,
        revised_timeout,
        ..
    } = parse_create_session_body(&rest)?;
    s.auth_token = auth_token;
    lm(
        2,
        &format!("CreateSession ok: timeout {}s", revised_timeout / 1000.0),
    )
    .await;

    // 4) ActivateSession
    s.seq += 1;
    s.handle += 1;
    let hid = s.handle;
    let creds = match (&s.username, &s.password) {
        (Some(u), Some(p)) => Some((u.as_str(), p.as_str())),
        _ => None,
    };
    let body = build_activate_session_body(now_unix_ms(), hid, &s.auth_token, creds);
    let frame = wrap_secure(b"MSG", s.channel_id, s.token_id, s.seq, hid, &body);
    let hexstr = hex(&frame);
    send_all(stream, &frame)?;
    rpt(
        "tx",
        "opc-ua",
        &hexstr,
        if creds.is_some() {
            "ActivateSession (user)"
        } else {
            "ActivateSession (anon)"
        },
    )
    .await;
    let rest = recv_service(stream, s.token_id, ID_ACTIVATE_SESSION_RSP).await?;
    let status = parse_activate_session_body(&rest)?;
    if status != 0 {
        return Err(format!("ActivateSession rejected: 0x{:08x}", status));
    }
    s.session_active = true;
    lm(2, "ActivateSession ok").await;
    Ok(())
}

export!(Plugin);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_parsing() {
        assert_eq!(
            parse_endpoint("opc.tcp://127.0.0.1:4840").unwrap(),
            ("127.0.0.1".to_string(), 4840)
        );
        assert_eq!(
            parse_endpoint("opc.tcp://server:8080").unwrap(),
            ("server".to_string(), 8080)
        );
        assert_eq!(
            parse_endpoint("opc.tcp://localhost").unwrap(),
            ("localhost".to_string(), 4840)
        );
        assert!(parse_endpoint("http://x:1").is_err());
        assert!(parse_endpoint("opc.tcp://").is_err());
    }

    #[test]
    fn hello_layout() {
        let h = build_hello("opc.tcp://127.0.0.1:4840");
        assert_eq!(&h[0..4], b"HELF");
        assert_eq!(h.len(), 28 + 24);
        assert_eq!(
            u32::from_le_bytes(h[4..8].try_into().unwrap()),
            h.len() as u32
        );
        assert_eq!(&h[28..], b"opc.tcp://127.0.0.1:4840");
    }

    #[test]
    fn secure_frame_layout() {
        let body = build_opn_body(1_700_000_000_000, 3);
        let f = wrap_secure(b"OPN", 0, 0, 1, 3, &body);
        assert_eq!(f.len(), 24 + body.len());
        assert_eq!(&f[0..3], b"OPN");
        assert_eq!(f[3], b'F');
        assert_eq!(
            u32::from_le_bytes(f[4..8].try_into().unwrap()),
            f.len() as u32
        );
        assert_eq!(u32::from_le_bytes(f[20..24].try_into().unwrap()), 3);
        assert_eq!(&f[24..], &body[..]);
    }
}
