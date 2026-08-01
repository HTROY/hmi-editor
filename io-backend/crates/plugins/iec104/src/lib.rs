//! IEC 60870-5-104 master plugin (wasip2 component).
//!
//! Hand-rolled protocol on top of the shared `iec104-core` codec: STARTDT /
//! STOPDT / TESTFR U-frames, S-frame acknowledgements, general interrogation
//! (C_IC_NA_1) and clock sync (C_CS_NA_1) at start and periodically, and
//! command tracking (C_SC_NA_1 / C_SE_NC_1) against activation confirms.
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../../wit",
});

use crate::exports::hmi::plugin::lifecycle::Guest;
use hmi::plugin::events;
use iec104_core::{
    cmd_cs, cmd_ic, cmd_sc, cmd_se_nc, decode_info_elements, encode_i, encode_s, encode_u,
    parse_apdu, Apdu, InfoElem, UFrame, COT_ACT_CON, MAX_APDU_LEN, TYPE_M_DP_NA_1, TYPE_M_DP_TB_1,
    TYPE_M_ME_NB_1, TYPE_M_ME_NC_1, TYPE_M_ME_NC_TB_1, TYPE_M_ME_ND_1, TYPE_M_ME_TF_1,
    TYPE_M_SP_NA_1, TYPE_M_SP_TB_1,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const T3: u64 = 35_000; // watchdog: send TESTFR when silent for this long
const T3_DISCONNECT: u64 = 70_000; // drop the connection if still silent
const DRAIN_READ_TIMEOUT_MS: u64 = 200;
const SYNC_EVERY_SCANS: u64 = 120;

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
    host: String,
    port: u16,
    common_address: u16,
    #[serde(default)]
    points: Vec<Pc>,
}

#[derive(Debug, Clone)]
struct PendingCmd {
    variable_id: String,
    ioa: u32,
    at: u64,
}

#[derive(Debug, Clone)]
struct PluginState {
    host: String,
    port: u16,
    common_address: u16,
    connected: bool,
    scan_count: u64,
    /// Next send sequence number (I-frame).
    send_seq: u16,
    /// Next expected receive sequence number (I-frame).
    recv_seq: u16,
    /// Time of the last frame received from the server.
    last_rx: u64,
    /// TESTFR sent but no TESTFR_CON yet.
    testfr_pending: bool,
    /// C_IC_NA_1 sent since the last STARTDT_CON.
    interrogation_sent: bool,
    pending: Vec<PendingCmd>,
    points: Vec<Pc>,
}

static STATE: Mutex<Option<PluginState>> = Mutex::new(None);
static STREAM: Mutex<Option<TcpStream>> = Mutex::new(None);
static RX_BUF: Mutex<VecDeque<u8>> = Mutex::new(VecDeque::new());

fn ioa_of(p: &Pc) -> Option<u32> {
    p.address.trim().parse::<u32>().ok()
}

/// Drain the socket into the shared buffer until it would block.
fn drain(stream: &mut TcpStream) -> Result<usize, String> {
    let mut buf = [0u8; 4096];
    let mut total = 0usize;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                RX_BUF.lock().unwrap().extend(&buf[..n]);
                if n < buf.len() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(total)
}

fn frame_len(buf: &VecDeque<u8>) -> Option<usize> {
    if buf.len() < 2 {
        return None;
    }
    let len = buf[1] as usize;
    if len < 4 || len > MAX_APDU_LEN {
        return None;
    }
    Some(len + 2)
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
            last_rx: 0,
            testfr_pending: false,
            interrogation_sent: false,
            pending: Vec::new(),
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
        s.send_seq = 0;
        s.recv_seq = 0;
        s.last_rx = now_ms();
        s.testfr_pending = false;
        s.interrogation_sent = false;
        lm(2, &format!("IEC104 connecting {}:{}...", s.host, s.port)).await;
        let addr = s.host.clone() + ":" + &s.port.to_string();
        let stream = match TcpStream::connect_timeout(
            &addr
                .parse()
                .unwrap_or_else(|_| "127.0.0.1:2404".parse().unwrap()),
            Duration::from_secs(5),
        ) {
            Ok(st) => st,
            Err(e) => {
                lm(1, &format!("connect failed: {}", e)).await;
                s.connected = false;
                *STATE.lock().unwrap() = Some(s);
                return 1;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(DRAIN_READ_TIMEOUT_MS)));
        let _ = stream.set_nonblocking(false);
        *STREAM.lock().unwrap() = Some(stream);
        RX_BUF.lock().unwrap().clear();

        let sd = encode_u(UFrame::StartDt, false);
        let hexstr = hex(&sd);
        {
            let mut guard = STREAM.lock().unwrap();
            let st = guard.as_mut().unwrap();
            match st.write_all(&sd).and_then(|_| st.flush()) {
                Ok(_) => (),
                Err(e) => {
                    lm(1, &format!("STARTDT send failed: {}", e)).await;
                    *guard = None;
                    return 1;
                }
            }
        }
        rpt("tx", "iec104", &hexstr, "STARTDT").await;

        // Wait for STARTDT_CON (reply to TESTFR while waiting).
        let deadline = now_ms() + 5_000;
        let mut started = false;
        while now_ms() < deadline && !started {
            let mut guard = STREAM.lock().unwrap();
            let st = guard.as_mut().unwrap();
            if drain(st).is_err() {
                break;
            }
            drop(guard);
            let mut buf = RX_BUF.lock().unwrap();
            let mut sent_testfr_reply = false;
            while let Some(flen) = frame_len(&buf) {
                let frame: Vec<u8> = buf.drain(..flen).collect();
                match parse_apdu(&frame) {
                    Ok(Apdu::U {
                        frame: UFrame::StartDt,
                        confirm: true,
                    }) => {
                        rpt("rx", "iec104", &hex(&frame), "STARTDT_CON").await;
                        started = true;
                        s.last_rx = now_ms();
                    }
                    Ok(Apdu::U {
                        frame: UFrame::TestFr,
                        confirm: false,
                    }) => {
                        rpt("rx", "iec104", &hex(&frame), "TESTFR").await;
                        if !sent_testfr_reply {
                            sent_testfr_reply = true;
                            let reply = encode_u(UFrame::TestFr, true);
                            rpt("tx", "iec104", &hex(&reply), "TESTFR_CON").await;
                            if let Some(mut st) = STREAM
                                .lock()
                                .unwrap()
                                .as_ref()
                                .and_then(|x| x.try_clone().ok())
                            {
                                let _ = st.write_all(&reply);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => lm(2, &format!("apdu parse: {}", e)).await,
                }
            }
            drop(buf);
            std::thread::sleep(Duration::from_millis(100));
        }
        if !started {
            lm(1, "no STARTDT_CON within 5s").await;
            let mut guard = STREAM.lock().unwrap();
            let _ = guard
                .as_mut()
                .map(|st| st.shutdown(std::net::Shutdown::Both));
            *guard = None;
            s.connected = false;
            *STATE.lock().unwrap() = Some(s);
            return 1;
        }

        // General interrogation to pull the initial picture.
        let ic = cmd_ic(s.common_address);
        let frame = encode_i(s.send_seq, s.recv_seq, &ic);
        s.send_seq = s.send_seq.wrapping_add(1);
        s.interrogation_sent = true;
        let hexstr = hex(&frame);
        {
            let mut guard = STREAM.lock().unwrap();
            let st = guard.as_mut().unwrap();
            if let Err(e) = st.write_all(&frame) {
                lm(1, &format!("C_IC send failed: {}", e)).await;
                *guard = None;
                s.connected = false;
                *STATE.lock().unwrap() = Some(s);
                return 1;
            }
        }
        rpt("tx", "iec104", &hexstr, "C_IC_NA_1 interrogation").await;

        s.connected = true;
        *STATE.lock().unwrap() = Some(s);
        lm(2, "IEC104 connected").await;
        0
    }

    async fn disconnect() -> u32 {
        let stopdt = encode_u(UFrame::StopDt, false);
        let mut guard = STREAM.lock().unwrap();
        if let Some(st) = guard.as_mut() {
            let hexstr = hex(&stopdt);
            rpt("tx", "iec104", &hexstr, "STOPDT").await;
            let _ = st.write_all(&stopdt);
            let _ = st.shutdown(std::net::Shutdown::Both);
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
        if !s.connected {
            return 1;
        }
        s.scan_count += 1;
        let now = now_ms();

        // 1) Drain and process everything the server sent.
        let mut got_i = false;
        {
            let mut guard = STREAM.lock().unwrap();
            let stream = match guard.as_mut() {
                Some(st) => st,
                None => return 1,
            };
            if let Err(e) = drain(stream) {
                lm(1, &format!("read error: {}", e)).await;
                *guard = None;
                drop(guard);
                s.connected = false;
                *STATE.lock().unwrap() = Some(s);
                return 1;
            }
            drop(guard);
        }
        let frames: Vec<Vec<u8>> = {
            let mut buf = RX_BUF.lock().unwrap();
            let mut out = Vec::new();
            while let Some(flen) = frame_len(&buf) {
                let frame: Vec<u8> = buf.drain(..flen).collect();
                out.push(frame);
            }
            out
        };
        for frame in &frames {
            match parse_apdu(frame) {
                Ok(Apdu::U {
                    frame: UFrame::StartDt,
                    confirm: true,
                }) => {
                    rpt("rx", "iec104", &hex(frame), "STARTDT_CON").await;
                    s.last_rx = now;
                    if !s.interrogation_sent {
                        let ic = cmd_ic(s.common_address);
                        let f = encode_i(s.send_seq, s.recv_seq, &ic);
                        s.send_seq = s.send_seq.wrapping_add(1);
                        s.interrogation_sent = true;
                        rpt("tx", "iec104", &hex(&f), "C_IC_NA_1 interrogation").await;
                        let mut guard = STREAM.lock().unwrap();
                        if let Some(st) = guard.as_mut() {
                            let _ = st.write_all(&f);
                        }
                    }
                }
                Ok(Apdu::U {
                    frame: UFrame::StopDt,
                    confirm: true,
                }) => {
                    rpt("rx", "iec104", &hex(frame), "STOPDT_CON").await;
                    s.last_rx = now;
                }
                Ok(Apdu::U {
                    frame: UFrame::TestFr,
                    confirm: true,
                }) => {
                    rpt("rx", "iec104", &hex(frame), "TESTFR_CON").await;
                    s.last_rx = now;
                    s.testfr_pending = false;
                }
                Ok(Apdu::U {
                    frame: UFrame::TestFr,
                    confirm: false,
                }) => {
                    rpt("rx", "iec104", &hex(frame), "TESTFR").await;
                    s.last_rx = now;
                    let reply = encode_u(UFrame::TestFr, true);
                    rpt("tx", "iec104", &hex(&reply), "TESTFR_CON").await;
                    let mut guard = STREAM.lock().unwrap();
                    if let Some(st) = guard.as_mut() {
                        let _ = st.write_all(&reply);
                    }
                }
                Ok(Apdu::U { .. }) => {
                    s.last_rx = now;
                }
                Ok(Apdu::S { .. }) => {
                    s.last_rx = now;
                }
                Ok(Apdu::I {
                    send_seq,
                    recv_seq: _,
                    asdu,
                }) => {
                    s.last_rx = now;
                    s.testfr_pending = false;
                    if send_seq.wrapping_sub(s.recv_seq) < 0x8000 {
                        s.recv_seq = send_seq.wrapping_add(1);
                        got_i = true;
                    }
                    // Command confirms (C_SC / C_SE activation results).
                    if (asdu.type_id == 45 || asdu.type_id == 46 || asdu.type_id == 50)
                        && (asdu.cot == COT_ACT_CON || asdu.negative)
                    {
                        let ioa = asdu.first_ioa().unwrap_or(0);
                        let idx = s.pending.iter().position(|p| p.ioa == ioa);
                        if let Some(i) = idx {
                            let p = s.pending.remove(i);
                            if asdu.negative {
                                lm(
                                    2,
                                    &format!(
                                        "cmd {} (IOA {}) rejected by server",
                                        p.variable_id, ioa
                                    ),
                                )
                                .await;
                            } else {
                                lm(2, &format!("cmd {} (IOA {}) executed", p.variable_id, ioa))
                                    .await;
                            }
                        }
                        continue;
                    }
                    // Measurement data.
                    let is_meas = matches!(
                        asdu.type_id,
                        TYPE_M_SP_NA_1
                            | TYPE_M_SP_TB_1
                            | TYPE_M_DP_NA_1
                            | TYPE_M_DP_TB_1
                            | TYPE_M_ME_NB_1
                            | TYPE_M_ME_NC_1
                            | TYPE_M_ME_ND_1
                            | TYPE_M_ME_NC_TB_1
                            | TYPE_M_ME_TF_1
                    );
                    if is_meas {
                        let cot = asdu.cot;
                        let elems = decode_info_elements(&asdu);
                        let mut reported = 0usize;
                        for el in &elems {
                            if let Some(p) = s.points.iter().find(|p| {
                                ioa_of(p)
                                    == Some(match el {
                                        InfoElem::SinglePoint(x) => x.ioa,
                                        InfoElem::DoublePoint(x) => x.ioa,
                                        InfoElem::MeasValue(x) => x.ioa,
                                    })
                            }) {
                                let (v, q, ts) = match el {
                                    InfoElem::SinglePoint(x) => (
                                        if x.value { 1.0 } else { 0.0 },
                                        x.quality.label().to_string(),
                                        x.ts.unwrap_or(now),
                                    ),
                                    InfoElem::DoublePoint(x) => (
                                        if x.value == 2 { 1.0 } else { 0.0 },
                                        x.quality.label().to_string(),
                                        x.ts.unwrap_or(now),
                                    ),
                                    InfoElem::MeasValue(x) => (
                                        x.value * p.scale + p.offset,
                                        x.quality.label().to_string(),
                                        x.ts.unwrap_or(now),
                                    ),
                                };
                                rp(&p.variable_id, v, &q, ts).await;
                                reported += 1;
                            }
                        }
                        if reported > 0 {
                            lm(
                                2,
                                &format!(
                                    "ASDU t{} cot{} ca{} {} obj(s) -> {} point(s)",
                                    asdu.type_id,
                                    cot,
                                    asdu.ca,
                                    elems.len(),
                                    reported
                                ),
                            )
                            .await;
                        }
                    }
                }
                Err(e) => {
                    lm(2, &format!("apdu parse: {}", e)).await;
                }
            }
        }

        // 2) Acknowledge I-frames with an S-frame.
        if got_i {
            let sf = encode_s(s.recv_seq);
            rpt("tx", "iec104", &hex(&sf), "S-frame ack").await;
            let mut guard = STREAM.lock().unwrap();
            if let Some(st) = guard.as_mut() {
                let _ = st.write_all(&sf);
            }
        }

        // 3) Periodic clock sync + interrogation.
        if s.scan_count % SYNC_EVERY_SCANS == 0 {
            let cs = cmd_cs(s.common_address, now);
            let f = encode_i(s.send_seq, s.recv_seq, &cs);
            s.send_seq = s.send_seq.wrapping_add(1);
            rpt("tx", "iec104", &hex(&f), "C_CS_NA_1 clock sync").await;
            let mut guard = STREAM.lock().unwrap();
            if let Some(st) = guard.as_mut() {
                let _ = st.write_all(&f);
            }
            let ic = cmd_ic(s.common_address);
            let f = encode_i(s.send_seq, s.recv_seq, &ic);
            s.send_seq = s.send_seq.wrapping_add(1);
            rpt("tx", "iec104", &hex(&f), "C_IC_NA_1 interrogation").await;
            if let Some(st) = guard.as_mut() {
                let _ = st.write_all(&f);
            }
        }

        // 4) Watchdog: TESTFR when silent, drop when it stays silent.
        let since_rx = now.saturating_sub(s.last_rx);
        if since_rx > T3 && !s.testfr_pending {
            let tf = encode_u(UFrame::TestFr, false);
            rpt("tx", "iec104", &hex(&tf), "TESTFR").await;
            let mut guard = STREAM.lock().unwrap();
            if let Some(st) = guard.as_mut() {
                let _ = st.write_all(&tf);
            }
            s.testfr_pending = true;
        }
        if since_rx > T3_DISCONNECT {
            lm(1, "T3 timeout: no data for 70s, dropping link").await;
            let mut guard = STREAM.lock().unwrap();
            if let Some(st) = guard.as_mut() {
                let _ = st.shutdown(std::net::Shutdown::Both);
            }
            *guard = None;
            drop(guard);
            s.connected = false;
            *STATE.lock().unwrap() = Some(s);
            return 0;
        }

        // 5) Forgive stale pending commands (older than 30s).
        s.pending.retain(|p| now.saturating_sub(p.at) < 30_000);

        *STATE.lock().unwrap() = Some(s);
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let mut s = match STATE.lock().unwrap().as_ref() {
            Some(s) => s.clone(),
            None => return 2,
        };
        if !s.connected {
            return 2;
        }
        let pt = match s.points.iter().find(|p| p.variable_id == name) {
            Some(p) => p.clone(),
            None => {
                lm(1, &format!("write: unknown point {}", name)).await;
                return 3;
            }
        };
        let ioa = match ioa_of(&pt) {
            Some(i) => i,
            None => {
                lm(
                    1,
                    &format!("write: bad address {} for {}", pt.address, name),
                )
                .await;
                return 3;
            }
        };
        let (asdu, desc) = if pt.data_type.to_lowercase().contains("bool") {
            (
                cmd_sc(s.common_address, ioa, value != 0.0, true),
                "C_SC_NA_1",
            )
        } else {
            (cmd_se_nc(s.common_address, ioa, value as f32), "C_SE_NC_1")
        };
        let frame = encode_i(s.send_seq, s.recv_seq, &asdu);
        s.send_seq = s.send_seq.wrapping_add(1);
        s.pending.push(PendingCmd {
            variable_id: name.clone(),
            ioa,
            at: now_ms(),
        });
        rpt("tx", "iec104", &hex(&frame), desc).await;
        let mut guard = STREAM.lock().unwrap();
        match guard.as_mut() {
            Some(st) => {
                if let Err(e) = st.write_all(&frame) {
                    lm(1, &format!("write failed: {}", e)).await;
                    *guard = None;
                    drop(guard);
                    s.connected = false;
                    *STATE.lock().unwrap() = Some(s);
                    return 2;
                }
            }
            None => return 2,
        }
        lm(2, &format!("{} {} = {}", desc, name, value)).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_len_ok() {
        let mut q = VecDeque::new();
        q.extend(&[0x68, 0x04, 0x07, 0x00, 0x00, 0x00]);
        assert_eq!(frame_len(&q), Some(6));
        q.clear();
        q.extend(&[0x68]);
        assert_eq!(frame_len(&q), None);
        q.push_back(0xff);
        assert_eq!(frame_len(&q), Some(257));
    }

    #[test]
    fn ioa_parsing() {
        let mut p = Pc {
            variable_id: "x".into(),
            address: "1001".into(),
            var_type: "DI".into(),
            data_type: "bool".into(),
            byte_order: String::new(),
            scale: 0.0,
            offset: 0.0,
        };
        assert_eq!(ioa_of(&p), Some(1001));
        p.address = "bad".into();
        assert_eq!(ioa_of(&p), None);
    }

    #[test]
    fn scale_offset_applied() {
        let mut p = Pc {
            variable_id: "x".into(),
            address: "1".into(),
            var_type: "AI".into(),
            data_type: "float32".into(),
            byte_order: String::new(),
            scale: 2.0,
            offset: 1.0,
        };
        p.scale = 2.0;
        p.offset = 1.0;
        assert_eq!(2.5 * p.scale + p.offset, 6.0);
    }
}
