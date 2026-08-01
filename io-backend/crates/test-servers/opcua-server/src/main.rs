//! Minimal OPC UA server (SecurityPolicy None) for end-to-end testing.
//!
//! Listens on 127.0.0.1:4840, serves the HEL/ACK + OPN handshake, session
//! management (CreateSession / ActivateSession, anonymous or username),
//! batched Read / Write on a small address space, and CloseSession /
//! CloseSecureChannel. Values are simulated with sine/cosine signals.
//!
//! Address space (mirrors io-backend/config.yaml plus writable test nodes):
//!   ns=2;s=Temperature.Zone1  Double, 22.5 + 5*sin(t/3)
//!   ns=2;s=Temperature.Zone2  Double, 19.0 + 3*cos(t/2)
//!   ns=2;s=Setpoint.Temperature  Double, writable
//!   ns=2;s=Acb.Closed            Boolean, writable
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use ua_core::{
    now_unix_ms, unix_ms_to_ua, DataValue, NodeId, NodeIdValue, Reader, VariantValue, Writer,
    ID_ACTIVATE_SESSION_REQ, ID_ACTIVATE_SESSION_RSP, ID_CLOSE_SECURE_CHANNEL_REQ,
    ID_CLOSE_SECURE_CHANNEL_RSP, ID_CLOSE_SESSION_REQ, ID_CLOSE_SESSION_RSP, ID_CREATE_SESSION_REQ,
    ID_CREATE_SESSION_RSP, ID_READ_REQ, ID_READ_RSP, ID_WRITE_REQ, ID_WRITE_RSP,
    STATUS_BAD_NODE_ID_UNKNOWN, STATUS_GOOD,
};

const PORT: u16 = 4840;

struct Node {
    value: VariantValue,
    writable: bool,
}

struct Server {
    channel_id: u32,
    token_id: u32,
    session_active: bool,
    nodes: HashMap<String, Node>,
    started: Instant,
}

impl Server {
    fn new() -> Self {
        let mut nodes = HashMap::new();
        nodes.insert(
            "ns=2;s=Temperature.Zone1".to_string(),
            Node {
                value: VariantValue::Double(22.5),
                writable: false,
            },
        );
        nodes.insert(
            "ns=2;s=Temperature.Zone2".to_string(),
            Node {
                value: VariantValue::Double(19.0),
                writable: false,
            },
        );
        nodes.insert(
            "ns=2;s=Setpoint.Temperature".to_string(),
            Node {
                value: VariantValue::Double(20.0),
                writable: true,
            },
        );
        nodes.insert(
            "ns=2;s=Acb.Closed".to_string(),
            Node {
                value: VariantValue::Boolean(false),
                writable: true,
            },
        );
        Self {
            channel_id: 0,
            token_id: 0,
            session_active: false,
            nodes,
            started: Instant::now(),
        }
    }

    fn update_sim(&mut self) {
        let t = self.started.elapsed().as_secs_f64();
        let zone1 = 22.5 + 5.0 * (t / 3.0).sin();
        let zone2 = 19.0 + 3.0 * (t / 2.0).cos();
        for (id, n) in self.nodes.iter_mut() {
            if n.writable {
                continue;
            }
            n.value = match id.as_str() {
                "ns=2;s=Temperature.Zone1" => VariantValue::Double(zone1),
                "ns=2;s=Temperature.Zone2" => VariantValue::Double(zone2),
                _ => continue,
            };
        }
    }

    fn node_key(&self, id: &NodeId) -> Option<String> {
        match &id.id {
            NodeIdValue::String(s) => Some(format!("ns={};s={}", id.ns, s)),
            _ => None,
        }
    }

    fn send(
        &self,
        stream: &mut TcpStream,
        msg_type: &[u8; 3],
        seq: u32,
        request_id: u32,
        body: &[u8],
    ) {
        let mut v = Vec::with_capacity(24 + body.len());
        v.extend_from_slice(msg_type);
        v.push(b'F');
        v.extend_from_slice(&((24 + body.len()) as u32).to_le_bytes());
        v.extend_from_slice(&self.channel_id.to_le_bytes());
        v.extend_from_slice(&self.token_id.to_le_bytes());
        v.extend_from_slice(&seq.to_le_bytes());
        v.extend_from_slice(&request_id.to_le_bytes());
        v.extend_from_slice(body);
        let hex: String = v
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        println!("TX {}: {}", String::from_utf8_lossy(msg_type), hex);
        if let Err(e) = stream.write_all(&v) {
            eprintln!("send error: {}", e);
        }
    }

    fn response_header(w: &mut Writer, handle: u32, status: u32) {
        w.i64(unix_ms_to_ua(now_unix_ms()));
        w.u32(handle);
        w.u32(status);
        w.u32(0); // serviceDiagnostics length
        w.u32(0); // stringTable length
        w.extension_object_null();
    }

    /// Parse a RequestHeader; returns the request handle.
    fn read_request_header(r: &mut Reader) -> Result<u32, String> {
        let _auth = r.node_id()?;
        let _ts = r.i64()?;
        let handle = r.u32()?;
        let _diag = r.u32()?;
        let _audit = r.str_()?;
        let _timeout = r.u32()?;
        let _additional = r.extension_object()?;
        Ok(handle)
    }

    fn handle_service(
        &mut self,
        stream: &mut TcpStream,
        seq: u32,
        request_id: u32,
        body: &[u8],
    ) -> bool {
        let mut r = Reader::new(body);
        let tid = match r.expanded_node_id() {
            Ok(n) => match n.id {
                NodeIdValue::Numeric(v) => v,
                _ => return true,
            },
            Err(e) => {
                eprintln!("bad service id: {}", e);
                return true;
            }
        };
        let handle = match Self::read_request_header(&mut r) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("bad request header: {}", e);
                return true;
            }
        };
        println!("RX service tid={} handle={}", tid, handle);
        match tid {
            ID_CREATE_SESSION_REQ => self.on_create_session(stream, handle, seq, request_id),
            ID_ACTIVATE_SESSION_REQ => self.on_activate_session(stream, handle, seq, request_id),
            ID_READ_REQ => self.on_read(stream, handle, seq, request_id, &mut r),
            ID_WRITE_REQ => self.on_write(stream, handle, seq, request_id, &mut r),
            ID_CLOSE_SESSION_REQ => {
                let mut w = Writer::new();
                w.expanded_node_id(&NodeId::numeric(0, ID_CLOSE_SESSION_RSP));
                Self::response_header(&mut w, handle, STATUS_GOOD);
                self.send(stream, b"MSG", seq, request_id, &w.into_bytes());
                true
            }
            ID_CLOSE_SECURE_CHANNEL_REQ => {
                let mut w = Writer::new();
                w.expanded_node_id(&NodeId::numeric(0, ID_CLOSE_SECURE_CHANNEL_RSP));
                Self::response_header(&mut w, handle, STATUS_GOOD);
                self.send(stream, b"CLO", seq, request_id, &w.into_bytes());
                false // close the channel
            }
            _ => {
                eprintln!("unhandled service tid={}", tid);
                true
            }
        }
    }

    fn on_create_session(
        &self,
        stream: &mut TcpStream,
        handle: u32,
        seq: u32,
        request_id: u32,
    ) -> bool {
        let mut w = Writer::new();
        w.expanded_node_id(&NodeId::numeric(0, ID_CREATE_SESSION_RSP));
        Self::response_header(&mut w, handle, STATUS_GOOD);
        w.node_id(&NodeId::numeric(1, 1)); // sessionId
        w.node_id(&NodeId::numeric(1, 2)); // authenticationToken
        w.f64(3_600_000.0); // revisedSessionTimeout
        w.bytes(&[]); // serverNonce
        w.bytes(&[]); // serverCertificate
        w.array_len(0); // serverEndpoints
        w.array_len(0); // serverSoftwareCertificates
        w.str_(""); // serverSignature.algorithm
        w.bytes(&[]); // serverSignature.signature
        w.u32(65_536); // maxRequestMessageSize
        self.send(stream, b"MSG", seq, request_id, &w.into_bytes());
        true
    }

    fn on_activate_session(
        &mut self,
        stream: &mut TcpStream,
        handle: u32,
        seq: u32,
        request_id: u32,
    ) -> bool {
        let mut w = Writer::new();
        w.expanded_node_id(&NodeId::numeric(0, ID_ACTIVATE_SESSION_RSP));
        Self::response_header(&mut w, handle, STATUS_GOOD);
        w.bytes(&[]); // serverNonce
        w.array_len(0); // results
        w.array_len(0); // diagnosticInfos
        self.session_active = true;
        self.send(stream, b"MSG", seq, request_id, &w.into_bytes());
        true
    }

    fn on_read(
        &mut self,
        stream: &mut TcpStream,
        handle: u32,
        seq: u32,
        request_id: u32,
        r: &mut Reader,
    ) -> bool {
        self.update_sim();
        let _max_age = match r.f64() {
            Ok(v) => v,
            Err(_) => return true,
        };
        let _timestamps = match r.u32() {
            Ok(v) => v,
            Err(_) => return true,
        };
        let n = match r.array_len(10_000) {
            Ok(v) => v,
            Err(_) => return true,
        };
        let mut dvs = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let node = match r.expanded_node_id() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let _attr = match r.u32() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let _index = match r.str_() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let _enc_ns = match r.u16() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let _enc_name = match r.str_() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let ts = unix_ms_to_ua(now_unix_ms());
            match self.node_key(&node).and_then(|k| self.nodes.get(&k)) {
                Some(n) => dvs.push(DataValue {
                    value: Some(n.value.clone()),
                    status: STATUS_GOOD,
                    source_ts: ts,
                    server_ts: ts,
                }),
                None => dvs.push(DataValue {
                    value: None,
                    status: STATUS_BAD_NODE_ID_UNKNOWN,
                    source_ts: ts,
                    server_ts: ts,
                }),
            }
        }
        let mut w = Writer::new();
        w.expanded_node_id(&NodeId::numeric(0, ID_READ_RSP));
        Self::response_header(&mut w, handle, STATUS_GOOD);
        w.array_len(dvs.len());
        for dv in &dvs {
            w.data_value(dv);
        }
        w.array_len(0); // diagnosticInfos
        self.send(stream, b"MSG", seq, request_id, &w.into_bytes());
        true
    }

    fn on_write(
        &mut self,
        stream: &mut TcpStream,
        handle: u32,
        seq: u32,
        request_id: u32,
        r: &mut Reader,
    ) -> bool {
        let n = match r.array_len(10_000) {
            Ok(v) => v,
            Err(_) => return true,
        };
        let mut statuses = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let node = match r.expanded_node_id() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let _attr = match r.u32() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let _index = match r.str_() {
                Ok(v) => v,
                Err(_) => return true,
            };
            let dv = match r.data_value() {
                Ok(v) => v,
                Err(_) => return true,
            };
            match self.node_key(&node) {
                Some(k) => match self.nodes.get_mut(&k) {
                    Some(n) if n.writable => {
                        n.value = dv.value.clone().unwrap_or(VariantValue::Double(0.0));
                        println!("WRITE {} -> {:?}", k, n.value);
                        statuses.push(STATUS_GOOD);
                    }
                    Some(_) => {
                        eprintln!("write rejected (read-only): {}", k);
                        statuses.push(0x8069_0000); // Bad_NotWritable
                    }
                    None => {
                        eprintln!("write unknown node: {}", k);
                        statuses.push(STATUS_BAD_NODE_ID_UNKNOWN);
                    }
                },
                None => statuses.push(STATUS_BAD_NODE_ID_UNKNOWN),
            }
        }
        let mut w = Writer::new();
        w.expanded_node_id(&NodeId::numeric(0, ID_WRITE_RSP));
        Self::response_header(&mut w, handle, STATUS_GOOD);
        w.array_len(statuses.len());
        for s in &statuses {
            w.u32(*s);
        }
        w.array_len(0); // diagnosticInfos
        self.send(stream, b"MSG", seq, request_id, &w.into_bytes());
        true
    }
}

fn handle_client(mut stream: TcpStream) {
    println!("client connected");
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    let mut server = Server::new();
    let mut rx = Vec::new();

    // HEL
    if read_message(&mut stream, &mut rx).is_err() {
        return;
    }
    // Validate the HEL message minimally, reply ACK.
    let mut ack = Vec::new();
    ack.extend_from_slice(b"ACKF");
    ack.extend_from_slice(&8u32.to_le_bytes());
    let hex: String = ack
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ");
    println!("TX ACK: {}", hex);
    let _ = stream.write_all(&ack);

    loop {
        let msg = match read_message(&mut stream, &mut rx) {
            Ok(m) => m,
            Err(_) => break,
        };
        if msg.len() < 24 || !matches!(&msg[0..3], b"OPN" | b"MSG" | b"CLO") {
            println!("unexpected message {:?}", &msg[0..3]);
            continue;
        }
        let channel_id = u32::from_le_bytes(msg[8..12].try_into().unwrap());
        let token_id = u32::from_le_bytes(msg[12..16].try_into().unwrap());
        let seq = u32::from_le_bytes(msg[16..20].try_into().unwrap());
        let request_id = u32::from_le_bytes(msg[20..24].try_into().unwrap());
        let body = &msg[24..];

        match &msg[0..3] {
            b"OPN" => {
                // Parse OpenSecureChannelRequest (we only care about the request id).
                let mut w = Writer::new();
                Server::response_header(&mut w, request_id, STATUS_GOOD);
                w.u32(0); // serverProtocolVersion
                w.u32(1); // channelId
                w.u32(2); // tokenId
                w.i64(unix_ms_to_ua(now_unix_ms()));
                w.u32(3_600_000); // revisedLifetime
                w.bytes(&[]); // serverNonce
                server.channel_id = 1;
                server.token_id = 2;
                server.send(&mut stream, b"OPN", seq, request_id, &w.into_bytes());
                println!("OPN accepted (channel=1 token=2)");
            }
            b"MSG" => {
                if server.channel_id == 0
                    || channel_id != server.channel_id
                    || token_id != server.token_id
                {
                    println!("MSG with wrong channel/token, dropping");
                    continue;
                }
                if !server.handle_service(&mut stream, seq, request_id, body) {
                    break;
                }
            }
            b"CLO" => {
                let mut w = Writer::new();
                Server::response_header(&mut w, request_id, STATUS_GOOD);
                server.send(&mut stream, b"CLO", seq, request_id, &w.into_bytes());
                println!("channel closed");
                break;
            }
            _ => {}
        }
    }
    println!("client disconnected");
}

fn read_message(stream: &mut TcpStream, rx: &mut Vec<u8>) -> Result<Vec<u8>, String> {
    let mut chunk = [0u8; 8192];
    let deadline = Instant::now() + Duration::from_secs(10);
    while rx.len() < 8 {
        match stream.read(&mut chunk) {
            Ok(0) => return Err("eof".into()),
            Ok(n) => rx.extend_from_slice(&chunk[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if Instant::now() > deadline {
                    return Err("timeout".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let size = u32::from_le_bytes(rx[4..8].try_into().unwrap()) as usize;
    while rx.len() < size {
        match stream.read(&mut chunk) {
            Ok(0) => return Err("eof".into()),
            Ok(n) => rx.extend_from_slice(&chunk[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if Instant::now() > deadline {
                    return Err("timeout".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let msg: Vec<u8> = rx.drain(..size).collect();
    let hex: String = msg
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ");
    println!("RX {}: {}", String::from_utf8_lossy(&msg[0..3]), hex);
    Ok(msg)
}

fn main() {
    println!("OPC UA server listening on 127.0.0.1:{}", PORT);
    let listener = TcpListener::bind(("127.0.0.1", PORT)).expect("bind 4840");
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => handle_client(stream),
            Err(e) => eprintln!("accept error: {}", e),
        }
    }
}
