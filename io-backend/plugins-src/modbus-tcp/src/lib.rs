//! Modbus TCP Protocol Plugin (wasip2 component)
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../wit",
});

use crate::exports::hmi::plugin::lifecycle::Guest;
use hmi::plugin::events;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MBAP_PROTOCOL_ID: u16 = 0;
const MBAP_HEADER_LEN: usize = 7;

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
static STREAM: Mutex<Option<Mbap>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn split_addr(address: &str) -> Result<(&'static str, u16), String> {
    for prefix in [
        "coil:",
        "holding_register:",
        "input_register:",
        "discrete_input:",
    ] {
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

fn hex_str(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<String>>()
        .join(" ")
}

/// Build a Modbus TCP (MBAP) request frame.
fn build_request_frame(tid: u16, uid: u8, pdu: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(MBAP_HEADER_LEN + pdu.len());
    frame.extend_from_slice(&tid.to_be_bytes());
    frame.extend_from_slice(&MBAP_PROTOCOL_ID.to_be_bytes());
    frame.extend_from_slice(&((1 + pdu.len()) as u16).to_be_bytes());
    frame.push(uid);
    frame.extend_from_slice(pdu);
    frame
}

/// Validate a complete response frame against the request and extract the data
/// payload (the bytes after the MBAP header + function code + byte count).
fn parse_response(
    tid: u16,
    uid: u8,
    req_fc: u8,
    expected_data: usize,
    expect_echo: bool,
    response: &[u8],
) -> Result<Vec<u8>, String> {
    if response.len() < MBAP_HEADER_LEN + 2 {
        return Err(format!("response too short: {} bytes", response.len()));
    }
    let rsp_tid = u16::from_be_bytes([response[0], response[1]]);
    let rsp_pid = u16::from_be_bytes([response[2], response[3]]);
    let rsp_len = u16::from_be_bytes([response[4], response[5]]) as usize;
    let rsp_uid = response[6];
    if rsp_tid != tid || rsp_pid != MBAP_PROTOCOL_ID || rsp_uid != uid {
        return Err(format!(
            "bad response header: tid={} pid={} uid={}",
            rsp_tid, rsp_pid, rsp_uid
        ));
    }
    if rsp_len < 1 || rsp_len > 254 {
        return Err(format!("bad response length: {}", rsp_len));
    }
    let body = &response[MBAP_HEADER_LEN..];
    if body.len() != rsp_len - 1 {
        return Err(format!(
            "response truncated: body {} bytes, header says {}",
            body.len(),
            rsp_len - 1
        ));
    }
    if body[0] & 0x80 != 0 {
        return Err(format!(
            "modbus exception 0x{:02x} (fc 0x{:02x})",
            body.get(1).copied().unwrap_or(0),
            body[0] & 0x7f
        ));
    }
    if body[0] != req_fc {
        return Err(format!("unexpected function code 0x{:02x}", body[0]));
    }
    if expect_echo {
        return Ok(Vec::new());
    }
    if body.len() < 2 || body[1] as usize != expected_data {
        return Err(format!(
            "unexpected data length: got {} want {}",
            body.get(1).copied().unwrap_or(0),
            expected_data
        ));
    }
    Ok(body[2..].to_vec())
}

/// Minimal Modbus TCP client over a raw TcpStream. Exists (instead of the
/// `modbus` crate) so every TX/RX frame can be captured and reported to the
/// host for the packet log.
struct Mbap {
    stream: TcpStream,
    tid: u16,
    uid: u8,
}

impl Mbap {
    fn connect(
        host: &str,
        port: u16,
        connect_timeout: Duration,
        read_timeout: Duration,
        write_timeout: Duration,
        uid: u8,
    ) -> std::io::Result<Self> {
        let addr = format!("{}:{}", host, port)
            .parse()
            .unwrap_or_else(|_| format!("127.0.0.1:{}", port).parse().unwrap());
        let stream = TcpStream::connect_timeout(&addr, connect_timeout)?;
        stream.set_read_timeout(Some(read_timeout))?;
        stream.set_write_timeout(Some(write_timeout))?;
        stream.set_nodelay(true)?;
        Ok(Self {
            stream,
            tid: 0,
            uid,
        })
    }

    fn close(&mut self) -> std::io::Result<()> {
        self.stream.shutdown(Shutdown::Both)
    }

    fn next_tid(&mut self) -> u16 {
        self.tid = self.tid.wrapping_add(1);
        self.tid
    }

    /// Send one request, log the TX frame, read the response and return the
    /// data payload plus hex dumps. Callers log the RX frame with a summary.
    async fn transaction(
        &mut self,
        fc: u8,
        pdu: &[u8],
        tx_summary: &str,
        expected_data: usize,
        expect_echo: bool,
    ) -> Result<(Vec<u8>, String, String), String> {
        let tid = self.next_tid();
        let frame = build_request_frame(tid, self.uid, pdu);
        let tx_hex = hex_str(&frame);
        events::on_packet(
            "tx".to_string(),
            "modbus".to_string(),
            tx_hex.clone(),
            tx_summary.to_string(),
        )
        .await;
        self.stream.write_all(&frame).map_err(|e| e.to_string())?;

        let mut head = [0u8; MBAP_HEADER_LEN];
        self.stream
            .read_exact(&mut head)
            .map_err(|e| e.to_string())?;
        let rsp_len = u16::from_be_bytes([head[4], head[5]]) as usize;
        if rsp_len < 1 || rsp_len > 254 {
            return Err(format!("bad response length: {}", rsp_len));
        }
        let mut body = vec![0u8; rsp_len - 1];
        self.stream
            .read_exact(&mut body)
            .map_err(|e| e.to_string())?;
        let mut response = head.to_vec();
        response.extend_from_slice(&body);
        let rx_hex = hex_str(&response);

        let data = parse_response(tid, self.uid, fc, expected_data, expect_echo, &response)?;
        Ok((data, tx_hex, rx_hex))
    }

    async fn log_rx(rx_hex: &str, summary: &str) {
        events::on_packet(
            "rx".to_string(),
            "modbus".to_string(),
            rx_hex.to_string(),
            summary.to_string(),
        )
        .await;
    }

    async fn read_bits(&mut self, fc: u8, fc_name: &str, addr: u16) -> Result<bool, String> {
        let mut pdu = Vec::with_capacity(5);
        pdu.push(fc);
        pdu.extend_from_slice(&addr.to_be_bytes());
        pdu.extend_from_slice(&1u16.to_be_bytes());
        let (data, _tx, rx_hex) = self
            .transaction(
                fc,
                &pdu,
                &format!("{} addr={} count=1", fc_name, addr),
                1,
                false,
            )
            .await?;
        let on = data[0] & 0x01 != 0;
        Self::log_rx(&rx_hex, &format!("resp: {}", if on { "On" } else { "Off" })).await;
        Ok(on)
    }

    async fn read_registers(
        &mut self,
        fc: u8,
        fc_name: &str,
        addr: u16,
        count: u16,
    ) -> Result<Vec<u16>, String> {
        let mut pdu = Vec::with_capacity(5);
        pdu.push(fc);
        pdu.extend_from_slice(&addr.to_be_bytes());
        pdu.extend_from_slice(&count.to_be_bytes());
        let (data, _tx, rx_hex) = self
            .transaction(
                fc,
                &pdu,
                &format!("{} addr={} count={}", fc_name, addr, count),
                (count as usize) * 2,
                false,
            )
            .await?;
        let mut regs = Vec::with_capacity(count as usize);
        for ch in data.chunks_exact(2) {
            regs.push(u16::from_be_bytes([ch[0], ch[1]]));
        }
        let hex = regs
            .iter()
            .map(|r| format!("{:04x}", r))
            .collect::<Vec<String>>()
            .join(" ");
        Self::log_rx(&rx_hex, &format!("resp: regs=[{}]", hex)).await;
        Ok(regs)
    }

    async fn write_single(
        &mut self,
        fc: u8,
        fc_name: &str,
        addr: u16,
        val: u16,
    ) -> Result<(), String> {
        let pdu = [
            fc,
            (addr >> 8) as u8,
            addr as u8,
            (val >> 8) as u8,
            val as u8,
        ];
        let (_data, _tx, rx_hex) = self
            .transaction(
                fc,
                &pdu,
                &format!("{} addr={} val=0x{:04x}", fc_name, addr, val),
                0,
                true,
            )
            .await?;
        Self::log_rx(&rx_hex, "resp: echo").await;
        Ok(())
    }

    async fn write_multiple_registers(&mut self, addr: u16, vals: &[u16]) -> Result<(), String> {
        let mut pdu = Vec::with_capacity(6 + vals.len() * 2);
        pdu.push(0x10);
        pdu.extend_from_slice(&addr.to_be_bytes());
        pdu.extend_from_slice(&(vals.len() as u16).to_be_bytes());
        pdu.push((vals.len() * 2) as u8);
        for v in vals {
            pdu.extend_from_slice(&v.to_be_bytes());
        }
        let vals_hex = vals
            .iter()
            .map(|v| format!("{:04x}", v))
            .collect::<Vec<String>>()
            .join(" ");
        let (_data, _tx, rx_hex) = self
            .transaction(
                0x10,
                &pdu,
                &format!(
                    "WR_MREG addr={} count={} val=[{}]",
                    addr,
                    vals.len(),
                    vals_hex
                ),
                0,
                true,
            )
            .await?;
        Self::log_rx(&rx_hex, "resp: echo").await;
        Ok(())
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
        match Mbap::connect(
            &s.host,
            s.port,
            Duration::from_secs(5),
            Duration::from_millis(2000),
            Duration::from_millis(2000),
            s.slave_id,
        ) {
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
            stream
                .write_single(5, "WR_COIL", addr, if on { 0xff00 } else { 0x0000 })
                .await
        } else if let Some(rest) = pt.address.strip_prefix("holding_register:") {
            let addr = match rest.parse::<u16>() {
                Ok(a) => a,
                Err(_) => return 3,
            };
            let vals = encode_value(&pt.data_type, &pt.byte_order, value);
            if vals.len() == 1 {
                stream.write_single(6, "WR_HREG", addr, vals[0]).await
            } else {
                stream.write_multiple_registers(addr, &vals).await
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

async fn mb_read(stream: &mut Mbap, pt: &Pc) -> Result<f64, String> {
    let (prefix, addr) = split_addr(&pt.address)?;
    match prefix {
        "coil:" => {
            let on = stream.read_bits(1, "RD_COIL", addr).await?;
            Ok(if on { 1.0 } else { 0.0 })
        }
        "discrete_input:" => {
            let on = stream.read_bits(2, "RD_DIN", addr).await?;
            Ok(if on { 1.0 } else { 0.0 })
        }
        "holding_register:" | "input_register:" => {
            let (fc, fc_name) = if prefix == "holding_register:" {
                (3u8, "RD_HREG")
            } else {
                (4u8, "RD_IREG")
            };
            let count = if is_32bit(&pt.data_type) { 2 } else { 1 };
            let regs = stream.read_registers(fc, fc_name, addr, count).await?;
            if regs.len() < count as usize {
                return Err("short response".to_string());
            }
            let w0 = regs[0];
            let w1 = if count == 2 { regs[1] } else { 0 };
            let value = decode_value(&pt.data_type, &pt.byte_order, w0, w1);
            Ok(value * pt.scale + pt.offset)
        }
        _ => Err(format!("unknown addr type: {}", pt.address)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_frame_basic() {
        let f = build_request_frame(0x0001, 0x01, &[0x03, 0x00, 0x00, 0x00, 0x02]);
        assert_eq!(
            f,
            [0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x03, 0x00, 0x00, 0x00, 0x02]
        );
    }

    #[test]
    fn build_frame_wr_mreg() {
        let mut pdu = vec![0x10u8];
        pdu.extend_from_slice(&0u16.to_be_bytes());
        pdu.extend_from_slice(&2u16.to_be_bytes());
        pdu.push(4);
        pdu.extend_from_slice(&0x3fc0u16.to_be_bytes());
        pdu.extend_from_slice(&0x0000u16.to_be_bytes());
        let f = build_request_frame(2, 1, &pdu);
        assert_eq!(
            f,
            [
                0x00, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x01, 0x10, 0x00, 0x00, 0x00, 0x02, 0x04, 0x3f,
                0xc0, 0x00, 0x00
            ]
        );
    }

    #[test]
    fn parse_ok_read_regs() {
        // FC03 read 2 regs: tid=5, pid=0, len=7 (uid+fc+count+4 data), uid=1
        let resp = [
            0x00, 0x05, 0x00, 0x00, 0x00, 0x07, 0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78,
        ];
        let data = parse_response(5, 1, 0x03, 4, false, &resp).unwrap();
        assert_eq!(data, [0x12, 0x34, 0x56, 0x78]);
    }

    #[test]
    fn parse_ok_read_bits() {
        // FC01 read 1 coil: len=4, data byte 0x01
        let resp = [0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x01, 0x01];
        let data = parse_response(1, 1, 0x01, 1, false, &resp).unwrap();
        assert_eq!(data, [0x01]);
    }

    #[test]
    fn parse_ok_write_echo() {
        // FC06 echo: len=6, body = 06 addr val
        let resp = [
            0x00, 0x03, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x00, 0x00, 0x12, 0x34,
        ];
        let data = parse_response(3, 1, 0x06, 0, true, &resp).unwrap();
        assert!(data.is_empty());
    }

    #[test]
    fn parse_exception() {
        let resp = [0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x01, 0x83, 0x02];
        let err = parse_response(1, 1, 0x03, 4, false, &resp).unwrap_err();
        assert!(err.contains("exception 0x02"), "{}", err);
    }

    #[test]
    fn parse_bad_tid() {
        let resp = [
            0x00, 0x99, 0x00, 0x00, 0x00, 0x07, 0x01, 0x03, 0x04, 0x12, 0x34, 0x56, 0x78,
        ];
        let err = parse_response(5, 1, 0x03, 4, false, &resp).unwrap_err();
        assert!(err.contains("tid=153"), "{}", err);
    }

    #[test]
    fn parse_short_response() {
        assert!(parse_response(1, 1, 0x03, 4, false, &[0, 1, 0, 0]).is_err());
    }

    #[test]
    fn parse_truncated_body() {
        let resp = [0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x01, 0x03, 0x04];
        assert!(parse_response(1, 1, 0x03, 4, false, &resp).is_err());
    }

    #[test]
    fn hex_str_formats() {
        assert_eq!(hex_str(&[0x00, 0x01, 0x0a, 0xff]), "00 01 0a ff");
        assert_eq!(hex_str(&[]), "");
    }

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
        assert_eq!(
            decode_value("uint32", "", 0x0001, 0x0000),
            0x0001_0000 as f64
        );
        assert_eq!(decode_value("int32", "", 0xffff, 0xffff), -1.0);
        assert_eq!(decode_value("float32", "", 0x3fc0, 0x0000), 1.5);
    }

    #[test]
    fn encode_value_types() {
        assert_eq!(encode_value("uint16", "", 42.0), vec![42]);
        assert_eq!(encode_value("int16", "", -1.0), vec![0xffff]);
        assert_eq!(
            encode_value("uint32", "", 0x12345678 as f64),
            vec![0x1234, 0x5678]
        );
        assert_eq!(encode_value("float32", "", 1.5), vec![0x3fc0, 0x0000]);
    }

    #[test]
    fn split_addr_cases() {
        assert_eq!(split_addr("coil:10").unwrap(), ("coil:", 10));
        assert_eq!(
            split_addr("holding_register:2").unwrap(),
            ("holding_register:", 2)
        );
        assert_eq!(
            split_addr("input_register:3").unwrap(),
            ("input_register:", 3)
        );
        assert_eq!(
            split_addr("discrete_input:4").unwrap(),
            ("discrete_input:", 4)
        );
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
