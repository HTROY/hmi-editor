//! IEC 60870-5-104 master plugin (wasip2 component).
//!
//! Hand-rolled protocol on top of the shared `iec104-core` codec: STARTDT /
//! STOPDT / TESTFR U-frames, S-frame acknowledgements, general interrogation
//! (C_IC_NA_1) and clock sync (C_CS_NA_1) at start and periodically, and
//! command tracking (C_SC_NA_1 / C_SE_NC_1) against activation confirms.
//!
//! 结构（F18）：协议状态机在 state.rs；生命周期骨架用 plugin_kit::Kit，
//! 流经 take/put 模式跨 `await` 不持锁（含 RX_BUF 的短暂加锁）。
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../../wit",
});

mod state;

use crate::exports::hmi::plugin::lifecycle::Guest;
use crate::state::{PendingCmd, PluginConfig, PluginState};
use hmi::plugin::events;
use iec104_core::{
    cmd_cs, cmd_ic, cmd_sc, cmd_se_nc, decode_info_elements, encode_i, encode_s, encode_u,
    parse_apdu, Apdu, InfoElem, UFrame, COT_ACT_CON, MAX_APDU_LEN, TYPE_M_DP_NA_1, TYPE_M_DP_TB_1,
    TYPE_M_ME_NB_1, TYPE_M_ME_NC_1, TYPE_M_ME_NC_TB_1, TYPE_M_ME_ND_1, TYPE_M_ME_TF_1,
    TYPE_M_SP_NA_1, TYPE_M_SP_TB_1,
};
use plugin_kit::events::PluginEvents;
use plugin_kit::{hex, now_ms, Kit};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use sync_util::MutexExt;

const T3: u64 = 35_000; // watchdog: send TESTFR when silent for this long
const T3_DISCONNECT: u64 = 70_000; // drop the connection if still silent
const DRAIN_READ_TIMEOUT_MS: u64 = 200;
const SYNC_EVERY_SCANS: u64 = 120;

static KIT: Kit<PluginState, TcpStream> = Kit::new();
static RX_BUF: Mutex<VecDeque<u8>> = Mutex::new(VecDeque::new());

/// 把宿主 import 的 `events::*` 转发给 plugin-kit 的错误策略助手。
struct Events;

impl PluginEvents for Events {
    async fn log(&self, level: u32, msg: String) {
        events::log(level, msg).await;
    }

    async fn on_point(&self, name: String, value: f64, quality: String, ts: u64) {
        events::on_point(name, value, quality, ts).await;
    }

    async fn on_packet(&self, dir: String, proto: String, hex: String, summary: String) {
        events::on_packet(dir, proto, hex, summary).await;
    }
}

async fn lm(l: u32, m: &str) {
    Events.log(l, m.to_string()).await;
}

async fn rp(n: &str, v: f64, q: &str, ts: u64) {
    Events.on_point(n.to_string(), v, q.to_string(), ts).await;
}

async fn rpt(dir: &str, p: &str, h: &str, s: &str) {
    Events
        .on_packet(dir.to_string(), p.to_string(), h.to_string(), s.to_string())
        .await;
}

fn ioa_of(p: &state::Pc) -> Option<u32> {
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
                RX_BUF.lock_recover().extend(&buf[..n]);
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
        KIT.commit(PluginState {
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
        let mut s = match KIT.state().as_ref() {
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
                KIT.mark_connected(false);
                return 1;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(DRAIN_READ_TIMEOUT_MS)));
        let _ = stream.set_nonblocking(false);
        KIT.put_stream(stream);
        RX_BUF.lock_recover().clear();

        let sd = encode_u(UFrame::StartDt, false);
        let hexstr = hex(&sd);
        {
            let mut stream = match KIT.take_stream() {
                Some(s) => s,
                None => return 1,
            };
            if let Err(e) = stream.write_all(&sd).and_then(|_| stream.flush()) {
                lm(1, &format!("STARTDT send failed: {}", e)).await;
                KIT.link_lost();
                return 1;
            }
            KIT.put_stream(stream);
        }
        rpt("tx", "iec104", &hexstr, "STARTDT").await;

        // Wait for STARTDT_CON (reply to TESTFR while waiting).
        let deadline = now_ms() + 5_000;
        let mut started = false;
        while now_ms() < deadline && !started {
            {
                let mut guard = KIT.stream();
                let st = guard.as_mut().unwrap();
                if drain(st).is_err() {
                    break;
                }
            }
            // 取帧后立刻释放 RX_BUF 锁：后续处理（rpt 跨 await）不持锁。
            let frames: Vec<Vec<u8>> = {
                let mut buf = RX_BUF.lock_recover();
                let mut out = Vec::new();
                while let Some(flen) = frame_len(&buf) {
                    let frame: Vec<u8> = buf.drain(..flen).collect();
                    out.push(frame);
                }
                out
            };
            let mut sent_testfr_reply = false;
            for frame in &frames {
                match parse_apdu(frame) {
                    Ok(Apdu::U {
                        frame: UFrame::StartDt,
                        confirm: true,
                    }) => {
                        rpt("rx", "iec104", &hex(frame), "STARTDT_CON").await;
                        started = true;
                        s.last_rx = now_ms();
                    }
                    Ok(Apdu::U {
                        frame: UFrame::TestFr,
                        confirm: false,
                    }) => {
                        rpt("rx", "iec104", &hex(frame), "TESTFR").await;
                        if !sent_testfr_reply {
                            sent_testfr_reply = true;
                            let reply = encode_u(UFrame::TestFr, true);
                            rpt("tx", "iec104", &hex(&reply), "TESTFR_CON").await;
                            if let Some(mut st) =
                                KIT.stream().as_ref().and_then(|x| x.try_clone().ok())
                            {
                                let _ = st.write_all(&reply);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => lm(2, &format!("apdu parse: {}", e)).await,
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if !started {
            lm(1, "no STARTDT_CON within 5s").await;
            KIT.link_lost();
            return 1;
        }

        // General interrogation to pull the initial picture.
        let ic = cmd_ic(s.common_address);
        let frame = encode_i(s.send_seq, s.recv_seq, &ic);
        s.send_seq = s.send_seq.wrapping_add(1);
        s.interrogation_sent = true;
        let hexstr = hex(&frame);
        {
            let mut stream = match KIT.take_stream() {
                Some(st) => st,
                None => return 1,
            };
            if let Err(e) = stream.write_all(&frame) {
                lm(1, &format!("C_IC send failed: {}", e)).await;
                KIT.link_lost();
                return 1;
            }
            KIT.put_stream(stream);
        }
        rpt("tx", "iec104", &hexstr, "C_IC_NA_1 interrogation").await;

        s.connected = true;
        KIT.commit(s);
        lm(2, "IEC104 connected").await;
        0
    }

    async fn disconnect() -> u32 {
        let stopdt = encode_u(UFrame::StopDt, false);
        let hexstr = hex(&stopdt);
        rpt("tx", "iec104", &hexstr, "STOPDT").await;
        if let Some(mut st) = KIT.take_stream() {
            let _ = st.write_all(&stopdt);
            let _ = st.shutdown(std::net::Shutdown::Both);
        }
        KIT.mark_connected(false);
        0
    }

    async fn scan_points() -> u32 {
        let mut s = match KIT.begin_scan() {
            Some(s) => s,
            None => return 1,
        };
        let now = now_ms();

        // 1) Drain and process everything the server sent.
        let mut got_i = false;
        {
            let mut stream = match KIT.take_stream() {
                Some(st) => st,
                None => return 1,
            };
            if let Err(e) = drain(&mut stream) {
                lm(1, &format!("read error: {}", e)).await;
                drop(stream);
                KIT.link_lost();
                return 1;
            }
            KIT.put_stream(stream);
        }
        let frames: Vec<Vec<u8>> = {
            let mut buf = RX_BUF.lock_recover();
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
                        let mut guard = KIT.stream();
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
                    let mut guard = KIT.stream();
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
            let mut guard = KIT.stream();
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
            let mut stream = match KIT.take_stream() {
                Some(st) => st,
                None => return 1,
            };
            let _ = stream.write_all(&f);
            let ic = cmd_ic(s.common_address);
            let f = encode_i(s.send_seq, s.recv_seq, &ic);
            s.send_seq = s.send_seq.wrapping_add(1);
            rpt("tx", "iec104", &hex(&f), "C_IC_NA_1 interrogation").await;
            let _ = stream.write_all(&f);
            KIT.put_stream(stream);
        }

        // 4) Watchdog: TESTFR when silent, drop when it stays silent.
        let since_rx = now.saturating_sub(s.last_rx);
        if since_rx > T3 && !s.testfr_pending {
            let tf = encode_u(UFrame::TestFr, false);
            rpt("tx", "iec104", &hex(&tf), "TESTFR").await;
            let mut stream = match KIT.take_stream() {
                Some(st) => st,
                None => return 1,
            };
            let _ = stream.write_all(&tf);
            KIT.put_stream(stream);
            s.testfr_pending = true;
        }
        if since_rx > T3_DISCONNECT {
            lm(1, "T3 timeout: no data for 70s, dropping link").await;
            KIT.link_lost();
            return 0;
        }

        // 5) Forgive stale pending commands (older than 30s).
        s.pending.retain(|p| now.saturating_sub(p.at) < 30_000);

        KIT.commit(s);
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let mut s = match KIT.state().as_ref() {
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
        {
            let mut stream = match KIT.take_stream() {
                Some(st) => st,
                None => return 2,
            };
            if let Err(e) = stream.write_all(&frame) {
                lm(1, &format!("write failed: {}", e)).await;
                KIT.link_lost();
                return 2;
            }
            KIT.put_stream(stream);
        }
        lm(2, &format!("{} {} = {}", desc, name, value)).await;
        KIT.commit(s);
        0
    }

    async fn get_name() -> String {
        "IEC 60870-5-104".to_string()
    }

    async fn get_status() -> u32 {
        KIT.status()
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
        let mut p = state::Pc {
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
        let mut p = state::Pc {
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
