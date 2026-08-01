//! Shared IEC 60870-5-104 codec (APCI/APDU framing + ASDU encode/decode).
//!
//! Pure `std` + `serde` so it compiles both for the `wasm32-wasip2` plugin
//! and for native test servers.
//!
//! Frame layout (APCI):
//! ```text
//! 0x68 | LEN | ctl0 ctl1 ctl2 ctl3 | ASDU (optional)
//! ```
//! Control field: bit0/bit1 select the format:
//! * `00` - I-format: send seq (bits 1..15), recv seq (bits 17..31)
//! * `01` - S-format: recv seq in ctl2/ctl3
//! * `11` - U-format: function in ctl0 bits 2..7, confirm flag bit 4
//! All multi-byte fields except the (IEEE 754, big-endian) floats are
//! little-endian as mandated by IEC 60870-5-101.

use serde::{Deserialize, Serialize};

pub const START_BYTE: u8 = 0x68;
pub const MAX_APDU_LEN: usize = 255;

// ── Type IDs ──────────────────────────────────────────────────────────────

pub const TYPE_M_SP_NA_1: u8 = 1; // single point
pub const TYPE_M_DP_NA_1: u8 = 3; // double point
pub const TYPE_M_ME_NB_1: u8 = 11; // scaled value + QDS
pub const TYPE_M_ME_NC_1: u8 = 13; // short float + QDS
pub const TYPE_M_ME_ND_1: u8 = 21; // short float, no QDS
pub const TYPE_M_SP_TB_1: u8 = 30; // single point + CP56Time2a
pub const TYPE_M_DP_TB_1: u8 = 31; // double point + CP56Time2a
pub const TYPE_M_ME_NC_TB_1: u8 = 35; // short float + QDS + CP56Time2a
pub const TYPE_M_ME_TF_1: u8 = 36; // short float + QDS + CP56Time2a
pub const TYPE_C_SC_NA_1: u8 = 45; // single command
pub const TYPE_C_DC_NA_1: u8 = 46; // double command
pub const TYPE_C_SE_NC_1: u8 = 50; // setpoint, short float
pub const TYPE_C_IC_NA_1: u8 = 100; // interrogation
pub const TYPE_C_CS_NA_1: u8 = 103; // clock sync

// ── Cause of transmission ─────────────────────────────────────────────────

pub const COT_PERIODIC: u8 = 1;
pub const COT_BACKGROUND: u8 = 2;
pub const COT_SPONTANEOUS: u8 = 3;
pub const COT_ACTIVATION: u8 = 6;
pub const COT_ACT_CON: u8 = 7;
pub const COT_ACT_TERM: u8 = 10;
pub const COT_INTERROGATED: u8 = 20;

// ── Quality ───────────────────────────────────────────────────────────────

/// Quality descriptor bits shared (with slightly different bit meanings per
/// descriptor type) across SIQ/DIQ/QDS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quality {
    pub overflow: bool,
    pub blocked: bool,
    pub substituted: bool,
    pub not_topical: bool,
    pub invalid: bool,
}

impl Quality {
    /// Good / no quality flags set.
    pub fn good() -> Self {
        Self {
            overflow: false,
            blocked: false,
            substituted: false,
            not_topical: false,
            invalid: false,
        }
    }

    pub fn from_siq(b: u8) -> Self {
        Self {
            overflow: false,
            blocked: b & 0x02 != 0,
            substituted: b & 0x04 != 0,
            not_topical: b & 0x08 != 0,
            invalid: b & 0x10 != 0,
        }
    }

    pub fn from_qds(b: u8) -> Self {
        Self {
            overflow: b & 0x01 != 0,
            blocked: b & 0x02 != 0,
            substituted: b & 0x04 != 0,
            not_topical: b & 0x08 != 0,
            invalid: b & 0x10 != 0,
        }
    }

    pub fn from_diq(b: u8) -> Self {
        Self {
            overflow: false,
            blocked: b & 0x04 != 0,
            substituted: b & 0x08 != 0,
            not_topical: b & 0x10 != 0,
            invalid: b & 0x20 != 0,
        }
    }

    pub fn is_good(&self) -> bool {
        !self.overflow && !self.blocked && !self.substituted && !self.not_topical && !self.invalid
    }

    /// Map to the quality label used by the HMI host ("good"/"uncertain"/"bad").
    pub fn label(&self) -> &'static str {
        if self.invalid {
            "bad"
        } else if self.is_good() {
            "good"
        } else {
            "uncertain"
        }
    }
}

// ── APDU ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UFrame {
    StartDt,
    StopDt,
    TestFr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Apdu {
    /// U-format frame, optionally a confirm.
    U { frame: UFrame, confirm: bool },
    /// S-format: acknowledgement of received I-frames.
    S { recv_seq: u16 },
    /// I-format: information / command transfer.
    I {
        send_seq: u16,
        recv_seq: u16,
        asdu: Asdu,
    },
}

/// Encode a U-format frame (STARTDT / STOPDT / TESTFR).
pub fn encode_u(frame: UFrame, confirm: bool) -> Vec<u8> {
    // bit0/1 = 11 marks a U-format frame; STARTDT / STOPDT / TESTFR use the
    // canonical control byte values from IEC 60870-5-104.
    let ctl0 = match (frame, confirm) {
        (UFrame::StartDt, false) => 0x07,
        (UFrame::StartDt, true) => 0x0b,
        (UFrame::StopDt, false) => 0x13,
        (UFrame::StopDt, true) => 0x23,
        (UFrame::TestFr, false) => 0x43,
        (UFrame::TestFr, true) => 0x83,
    };
    vec![START_BYTE, 0x04, ctl0, 0x00, 0x00, 0x00]
}

/// Encode an S-format frame.
pub fn encode_s(recv_seq: u16) -> Vec<u8> {
    let c2 = ((recv_seq << 1) & 0xfe) as u8;
    let c3 = (recv_seq >> 7) as u8;
    vec![START_BYTE, 0x04, 0x01, 0x00, c2, c3]
}

/// Encode an I-format frame around an ASDU.
pub fn encode_i(send_seq: u16, recv_seq: u16, asdu: &Asdu) -> Vec<u8> {
    let body = asdu.encode();
    let c0 = ((send_seq << 1) & 0xfe) as u8;
    let c1 = (send_seq >> 7) as u8;
    let c2 = ((recv_seq << 1) & 0xfe) as u8;
    let c3 = (recv_seq >> 7) as u8;
    let mut f = Vec::with_capacity(6 + body.len());
    f.push(START_BYTE);
    f.push((body.len() + 4) as u8);
    f.extend_from_slice(&[c0, c1, c2, c3]);
    f.extend_from_slice(&body);
    f
}

/// Parse a complete APDU (including start byte and length field).
pub fn parse_apdu(bytes: &[u8]) -> Result<Apdu, String> {
    if bytes.len() < 6 {
        return Err(format!("apdu too short: {} bytes", bytes.len()));
    }
    if bytes[0] != START_BYTE {
        return Err(format!("bad start byte 0x{:02x}", bytes[0]));
    }
    let len = bytes[1] as usize;
    if len < 4 || len > MAX_APDU_LEN || bytes.len() < len + 2 {
        return Err(format!("bad length field: {}", len));
    }
    let ctl = [bytes[2], bytes[3], bytes[4], bytes[5]];
    // Format discriminator: I-format has bit0 = 0, S-format bits0/1 = 01,
    // U-format bits0/1 = 11.
    if ctl[0] & 0x01 == 0 {
        let send_seq = ((ctl[0] & 0xfe) as u16) | ((ctl[1] as u16) << 8);
        let recv_seq = ((ctl[2] & 0xfe) as u16) | ((ctl[3] as u16) << 8);
        let asdu = Asdu::parse(&bytes[6..6 + len - 4])?;
        Ok(Apdu::I {
            send_seq: send_seq >> 1,
            recv_seq: recv_seq >> 1,
            asdu,
        })
    } else {
        match ctl[0] & 0x03 {
            1 => {
                let recv_seq = ((ctl[2] & 0xfe) as u16) | ((ctl[3] as u16) << 8);
                Ok(Apdu::S {
                    recv_seq: recv_seq >> 1,
                })
            }
            3 => {
                let f = ctl[0];
                let (frame, confirm) = match f {
                    0x07 => (UFrame::StartDt, false),
                    0x0b => (UFrame::StartDt, true),
                    0x13 => (UFrame::StopDt, false),
                    0x23 => (UFrame::StopDt, true),
                    0x43 => (UFrame::TestFr, false),
                    0x83 => (UFrame::TestFr, true),
                    _ => return Err(format!("unknown U-format function 0x{:02x}", f)),
                };
                Ok(Apdu::U { frame, confirm })
            }
            _ => Err(format!("unknown control field 0x{:02x}", ctl[0])),
        }
    }
}

// ── ASDU ──────────────────────────────────────────────────────────────────

/// A decoded ASDU. `info` holds the raw information element bytes; use
/// [`decode_info_elements`] to turn them into typed values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asdu {
    pub type_id: u8,
    /// Number of information objects (vsq bits 0..6).
    pub num: u8,
    /// vsq bit 7: sequence of consecutive addresses.
    pub sequence: bool,
    /// Cause of transmission (bits 0..5 of the cause byte).
    pub cot: u8,
    /// P/N bit (negative confirmation).
    pub negative: bool,
    /// T bit (test frame).
    pub test: bool,
    /// Originator address (cause byte 2).
    pub originator: u8,
    /// Common address (CASDU).
    pub ca: u16,
    pub info: Vec<u8>,
}

impl Asdu {
    pub fn new(type_id: u8, cot: u8, negative: bool, ca: u16, num: u8, info: Vec<u8>) -> Self {
        Self {
            type_id,
            num,
            sequence: false,
            cot,
            negative,
            test: false,
            originator: 0,
            ca,
            info,
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 6 {
            return Err(format!("asdu too short: {} bytes", bytes.len()));
        }
        let vsq = bytes[1];
        let cot_byte = bytes[2];
        let cot = cot_byte & 0x3f;
        let negative = cot_byte & 0x40 != 0;
        let test = cot_byte & 0x80 != 0;
        let ca = u16::from_le_bytes([bytes[4], bytes[5]]);
        let num = vsq & 0x7f;
        Ok(Self {
            type_id: bytes[0],
            num,
            sequence: vsq & 0x80 != 0,
            cot,
            negative,
            test,
            originator: bytes[3],
            ca,
            info: bytes[6..].to_vec(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut cot_byte = self.cot & 0x3f;
        if self.negative {
            cot_byte |= 0x40;
        }
        if self.test {
            cot_byte |= 0x80;
        }
        let mut b = Vec::with_capacity(6 + self.info.len());
        b.push(self.type_id);
        b.push((self.num & 0x7f) | if self.sequence { 0x80 } else { 0 });
        b.push(cot_byte);
        b.push(self.originator);
        b.extend_from_slice(&self.ca.to_le_bytes());
        b.extend_from_slice(&self.info);
        b
    }

    /// IOA of the first information object (3 bytes, little-endian).
    pub fn first_ioa(&self) -> Option<u32> {
        if self.info.len() < 3 {
            None
        } else {
            Some(u32::from_le_bytes([
                self.info[0],
                self.info[1],
                self.info[2],
                0,
            ]))
        }
    }
}

// ── Info element decoding ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SinglePoint {
    pub ioa: u32,
    pub value: bool,
    pub quality: Quality,
    /// Unix milliseconds, when the object carries a CP56Time2a tag.
    pub ts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DoublePoint {
    pub ioa: u32,
    /// 0 = indeterminate, 1 = off, 2 = on, 3 = indeterminate.
    pub value: u8,
    pub quality: Quality,
    /// Unix milliseconds, when the object carries a CP56Time2a tag.
    pub ts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeasValue {
    pub ioa: u32,
    pub value: f64,
    pub quality: Quality,
    /// Unix milliseconds, when the object carries a CP56Time2a tag.
    pub ts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InfoElem {
    SinglePoint(SinglePoint),
    DoublePoint(DoublePoint),
    MeasValue(MeasValue),
}

/// Decode the information elements of a measurement ASDU into typed values.
/// Returns the number of decoded objects (may be fewer than `asdu.num` when
/// the payload is truncated, in which case the tail is silently dropped).
pub fn decode_info_elements(asdu: &Asdu) -> Vec<InfoElem> {
    let (base_ioa, step) = if asdu.sequence {
        (asdu.first_ioa().unwrap_or(0), 1)
    } else {
        (0, 1)
    };
    let mut out = Vec::new();
    let mut pos = 0usize;
    for idx in 0..asdu.num {
        let ioa = if asdu.sequence {
            base_ioa + idx as u32 * step
        } else {
            if asdu.info.len() < pos + 3 {
                break;
            }
            let i = u32::from_le_bytes([asdu.info[pos], asdu.info[pos + 1], asdu.info[pos + 2], 0]);
            pos += 3;
            i
        };
        let elem = match asdu.type_id {
            TYPE_M_SP_NA_1 => {
                if asdu.info.len() < pos + 1 {
                    break;
                }
                let q = Quality::from_siq(asdu.info[pos]);
                let v = asdu.info[pos] & 0x01 != 0;
                pos += 1;
                InfoElem::SinglePoint(SinglePoint {
                    ioa,
                    value: v,
                    quality: q,
                    ts: None,
                })
            }
            TYPE_M_SP_TB_1 => {
                if asdu.info.len() < pos + 8 {
                    break;
                }
                let q = Quality::from_siq(asdu.info[pos]);
                let v = asdu.info[pos] & 0x01 != 0;
                let ts = decode_cp56_time(&asdu.info[pos + 1..pos + 8]);
                pos += 8;
                InfoElem::SinglePoint(SinglePoint {
                    ioa,
                    value: v,
                    quality: q,
                    ts,
                })
            }
            TYPE_M_DP_NA_1 => {
                if asdu.info.len() < pos + 1 {
                    break;
                }
                let q = Quality::from_diq(asdu.info[pos]);
                let v = asdu.info[pos] & 0x03;
                pos += 1;
                InfoElem::DoublePoint(DoublePoint {
                    ioa,
                    value: v,
                    quality: q,
                    ts: None,
                })
            }
            TYPE_M_DP_TB_1 => {
                if asdu.info.len() < pos + 8 {
                    break;
                }
                let q = Quality::from_diq(asdu.info[pos]);
                let v = asdu.info[pos] & 0x03;
                let ts = decode_cp56_time(&asdu.info[pos + 1..pos + 8]);
                pos += 8;
                InfoElem::DoublePoint(DoublePoint {
                    ioa,
                    value: v,
                    quality: q,
                    ts,
                })
            }
            TYPE_M_ME_NB_1 => {
                if asdu.info.len() < pos + 3 {
                    break;
                }
                let raw = i16::from_le_bytes([asdu.info[pos], asdu.info[pos + 1]]);
                let q = Quality::from_qds(asdu.info[pos + 2]);
                pos += 3;
                InfoElem::MeasValue(MeasValue {
                    ioa,
                    value: raw as f64,
                    quality: q,
                    ts: None,
                })
            }
            TYPE_M_ME_NC_1 => {
                if asdu.info.len() < pos + 5 {
                    break;
                }
                let v = decode_f32_be(&asdu.info[pos..pos + 4]);
                let q = Quality::from_qds(asdu.info[pos + 4]);
                pos += 5;
                InfoElem::MeasValue(MeasValue {
                    ioa,
                    value: v,
                    quality: q,
                    ts: None,
                })
            }
            TYPE_M_ME_ND_1 => {
                if asdu.info.len() < pos + 4 {
                    break;
                }
                let v = decode_f32_be(&asdu.info[pos..pos + 4]);
                pos += 4;
                InfoElem::MeasValue(MeasValue {
                    ioa,
                    value: v,
                    quality: Quality::good(),
                    ts: None,
                })
            }
            TYPE_M_ME_NC_TB_1 | TYPE_M_ME_TF_1 => {
                if asdu.info.len() < pos + 12 {
                    break;
                }
                let v = decode_f32_be(&asdu.info[pos..pos + 4]);
                let q = Quality::from_qds(asdu.info[pos + 4]);
                let ts = decode_cp56_time(&asdu.info[pos + 5..pos + 12]);
                pos += 12;
                InfoElem::MeasValue(MeasValue {
                    ioa,
                    value: v,
                    quality: q,
                    ts,
                })
            }
            _ => break,
        };
        out.push(elem);
    }
    out
}

// ── Command / measurement builders (for master + slave) ───────────────────

fn ioa_bytes(ioa: u32) -> [u8; 3] {
    [ioa as u8, (ioa >> 8) as u8, (ioa >> 16) as u8]
}

fn single_info(ioa: u32, body: Vec<u8>) -> Vec<u8> {
    let mut v = Vec::with_capacity(3 + body.len());
    v.extend_from_slice(&ioa_bytes(ioa));
    v.extend_from_slice(&body);
    v
}

/// C_SC_NA_1: single command. `execute` sets the S/E bit.
pub fn cmd_sc(ca: u16, ioa: u32, on: bool, execute: bool) -> Asdu {
    let mut sco = if on { 0x01 } else { 0x00 };
    if execute {
        sco |= 0x80;
    }
    Asdu::new(
        TYPE_C_SC_NA_1,
        COT_ACTIVATION,
        false,
        ca,
        1,
        single_info(ioa, vec![sco]),
    )
}

/// C_DC_NA_1: double command. `on` maps to off/on, indeterminate if neither.
pub fn cmd_dc(ca: u16, ioa: u32, on: Option<bool>, execute: bool) -> Asdu {
    let mut sco = match on {
        Some(false) => 0x01,
        Some(true) => 0x02,
        None => 0x00,
    };
    if execute {
        sco |= 0x80;
    }
    Asdu::new(
        TYPE_C_DC_NA_1,
        COT_ACTIVATION,
        false,
        ca,
        1,
        single_info(ioa, vec![sco]),
    )
}

/// C_SE_NC_1: setpoint command, short float.
pub fn cmd_se_nc(ca: u16, ioa: u32, value: f32) -> Asdu {
    let mut info = ioa_bytes(ioa).to_vec();
    info.extend_from_slice(&value.to_be_bytes());
    info.push(0x00); // QOS: no qualifier bits
    Asdu::new(TYPE_C_SE_NC_1, COT_ACTIVATION, false, ca, 1, info)
}

/// C_IC_NA_1: general interrogation (IOA 0, COT activation).
pub fn cmd_ic(ca: u16) -> Asdu {
    Asdu::new(
        TYPE_C_IC_NA_1,
        COT_ACTIVATION,
        false,
        ca,
        1,
        ioa_bytes(0).to_vec(),
    )
}

/// C_CS_NA_1: clock synchronization with the current time.
pub fn cmd_cs(ca: u16, ts_ms: u64) -> Asdu {
    Asdu::new(
        TYPE_C_CS_NA_1,
        COT_ACTIVATION,
        false,
        ca,
        1,
        encode_cp56_time(ts_ms).to_vec(),
    )
}

/// M_SP_NA_1: single point information.
pub fn m_sp(ca: u16, ioa: u32, on: bool, q: Quality, cot: u8) -> Asdu {
    let mut siq = if on { 0x01 } else { 0x00 };
    if q.blocked {
        siq |= 0x02;
    }
    if q.substituted {
        siq |= 0x04;
    }
    if q.not_topical {
        siq |= 0x08;
    }
    if q.invalid {
        siq |= 0x10;
    }
    Asdu::new(
        TYPE_M_SP_NA_1,
        cot,
        false,
        ca,
        1,
        single_info(ioa, vec![siq]),
    )
}

/// M_SP_TB_1: single point information with time tag.
pub fn m_sp_tb(ca: u16, ioa: u32, on: bool, q: Quality, cot: u8, ts_ms: u64) -> Asdu {
    let mut siq = if on { 0x01 } else { 0x00 };
    if q.blocked {
        siq |= 0x02;
    }
    if q.substituted {
        siq |= 0x04;
    }
    if q.not_topical {
        siq |= 0x08;
    }
    if q.invalid {
        siq |= 0x10;
    }
    let mut info = single_info(ioa, vec![siq]);
    info.extend_from_slice(&encode_cp56_time(ts_ms));
    Asdu::new(TYPE_M_SP_TB_1, cot, false, ca, 1, info)
}

/// M_ME_NC_1: measured value, short float with quality.
pub fn m_me_nc(ca: u16, ioa: u32, value: f32, q: Quality, cot: u8) -> Asdu {
    let mut qds = 0u8;
    if q.overflow {
        qds |= 0x01;
    }
    if q.blocked {
        qds |= 0x02;
    }
    if q.substituted {
        qds |= 0x04;
    }
    if q.not_topical {
        qds |= 0x08;
    }
    if q.invalid {
        qds |= 0x10;
    }
    let mut info = ioa_bytes(ioa).to_vec();
    info.extend_from_slice(&value.to_be_bytes());
    info.push(qds);
    Asdu::new(TYPE_M_ME_NC_1, cot, false, ca, 1, info)
}

/// M_ME_TF_1: measured value, short float with quality and time tag.
pub fn m_me_tf(ca: u16, ioa: u32, value: f32, q: Quality, cot: u8, ts_ms: u64) -> Asdu {
    let mut qds = 0u8;
    if q.overflow {
        qds |= 0x01;
    }
    if q.blocked {
        qds |= 0x02;
    }
    if q.substituted {
        qds |= 0x04;
    }
    if q.not_topical {
        qds |= 0x08;
    }
    if q.invalid {
        qds |= 0x10;
    }
    let mut info = ioa_bytes(ioa).to_vec();
    info.extend_from_slice(&value.to_be_bytes());
    info.push(qds);
    info.extend_from_slice(&encode_cp56_time(ts_ms));
    Asdu::new(TYPE_M_ME_TF_1, cot, false, ca, 1, info)
}

// ── Primitive codecs ──────────────────────────────────────────────────────

/// Decode a big-endian IEEE 754 float (as used by IEC 104).
pub fn decode_f32_be(b: &[u8]) -> f64 {
    let mut raw = [0u8; 4];
    raw.copy_from_slice(&b[..4]);
    f32::from_be_bytes(raw) as f64
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Decode a CP56Time2a tag into unix milliseconds. Returns `None` when the
/// tag is invalid (e.g. the "invalid" bit set) or `b` is too short.
pub fn decode_cp56_time(b: &[u8]) -> Option<u64> {
    if b.len() < 7 {
        return None;
    }
    if b[5] & 0x80 != 0 {
        return None; // IV bit: time not valid
    }
    let ms = u16::from_le_bytes([b[0], b[1]]);
    let min = (b[2] & 0x3f) as u32;
    let hour = (b[3] & 0x1f) as u32;
    let day = (b[4] & 0x1f) as u32;
    let month = (b[5] & 0x0f) as u32;
    let year = 2000 + (b[6] & 0x7f) as i64;
    if day == 0 || month == 0 || month > 12 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86400 + hour as i64 * 3600 + min as i64 * 60;
    Some(secs as u64 * 1000 + ms as u64)
}

/// Encode unix milliseconds into a CP56Time2a tag (7 bytes). Values outside
/// 2000..2099 are clamped. Note the tag carries milliseconds-of-minute, so
/// the seconds component of `ts_ms` is folded into the ms field.
pub fn encode_cp56_time(ts_ms: u64) -> [u8; 7] {
    let ms_of_min = ts_ms % 60_000;
    let total_min = ts_ms / 60_000;
    let min = (total_min % 60) as u32;
    let hour = ((total_min / 60) % 24) as u32;
    let days = (total_min / (60 * 24)) as i64;
    let (year, month, day) = civil_from_days(days);
    let yy = (year - 2000).clamp(0, 99) as u8;
    [
        ms_of_min as u8,
        (ms_of_min >> 8) as u8,
        (min & 0x3f) as u8,
        (hour & 0x1f) as u8,
        (day & 0x1f) as u8,
        (month & 0x0f) as u8,
        yy & 0x7f,
    ]
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_u_frames() {
        assert_eq!(
            encode_u(UFrame::StartDt, false),
            [0x68, 0x04, 0x07, 0, 0, 0]
        );
        assert_eq!(encode_u(UFrame::StartDt, true), [0x68, 0x04, 0x0b, 0, 0, 0]);
        assert_eq!(encode_u(UFrame::StopDt, false), [0x68, 0x04, 0x13, 0, 0, 0]);
        assert_eq!(encode_u(UFrame::TestFr, false), [0x68, 0x04, 0x43, 0, 0, 0]);
        assert_eq!(encode_u(UFrame::TestFr, true), [0x68, 0x04, 0x83, 0, 0, 0]);
    }

    #[test]
    fn encode_s_frame() {
        assert_eq!(encode_s(5), [0x68, 0x04, 0x01, 0x00, 0x0a, 0x00]);
    }

    #[test]
    fn parse_u_s_frames() {
        assert_eq!(
            parse_apdu(&[0x68, 0x04, 0x07, 0, 0, 0]).unwrap(),
            Apdu::U {
                frame: UFrame::StartDt,
                confirm: false
            }
        );
        assert_eq!(
            parse_apdu(&[0x68, 0x04, 0x83, 0, 0, 0]).unwrap(),
            Apdu::U {
                frame: UFrame::TestFr,
                confirm: true
            }
        );
        assert_eq!(
            parse_apdu(&[0x68, 0x04, 0x01, 0x00, 0x0a, 0x00]).unwrap(),
            Apdu::S { recv_seq: 5 }
        );
        assert!(parse_apdu(&[0x68, 0x03, 0x07, 0, 0]).is_err());
        assert!(parse_apdu(&[0x69, 0x04, 0x07, 0, 0, 0]).is_err());
    }

    #[test]
    fn i_frame_roundtrip() {
        let asdu = cmd_ic(1);
        let f = encode_i(3, 7, &asdu);
        assert_eq!(f[0], 0x68);
        assert_eq!(f[1] as usize, f.len() - 2);
        match parse_apdu(&f).unwrap() {
            Apdu::I {
                send_seq,
                recv_seq,
                asdu: a,
            } => {
                assert_eq!(send_seq, 3);
                assert_eq!(recv_seq, 7);
                assert_eq!(a.type_id, TYPE_C_IC_NA_1);
                assert_eq!(a.ca, 1);
                assert_eq!(a.cot, COT_ACTIVATION);
                assert_eq!(a.first_ioa(), Some(0));
            }
            _ => panic!("expected I frame"),
        }
    }

    #[test]
    fn parse_c_sc_command() {
        // C_SC_NA_1, COT=6 activation, ca=1, ioa=1001, SCO=0x81 (on, execute)
        let asdu = cmd_sc(1, 1001, true, true);
        let f = encode_i(0, 0, &asdu);
        match parse_apdu(&f).unwrap() {
            Apdu::I { asdu, .. } => {
                let elems = decode_info_elements(&asdu);
                assert!(elems.is_empty()); // commands have no measurement decode
                assert_eq!(asdu.first_ioa(), Some(1001));
            }
            _ => panic!("expected I frame"),
        }
        assert_eq!(
            asdu.encode(),
            [
                TYPE_C_SC_NA_1,
                0x01,
                COT_ACTIVATION,
                0x00,
                0x01,
                0x00,
                0xe9,
                0x03,
                0x00,
                0x81
            ]
        );
    }

    #[test]
    fn decode_m_sp_na_1() {
        let q = Quality::good();
        let asdu = m_sp(1, 1001, true, q, COT_INTERROGATED);
        let elems = decode_info_elements(&asdu);
        assert_eq!(elems.len(), 1);
        match elems[0] {
            InfoElem::SinglePoint(s) => {
                assert_eq!(s.ioa, 1001);
                assert!(s.value);
                assert!(s.quality.is_good());
            }
            _ => panic!("wrong elem"),
        }
    }

    #[test]
    fn decode_m_me_nc_1() {
        let q = Quality {
            overflow: false,
            blocked: false,
            substituted: false,
            not_topical: true,
            invalid: false,
        };
        let asdu = m_me_nc(1, 1003, 1.5, q, COT_SPONTANEOUS);
        let elems = decode_info_elements(&asdu);
        assert_eq!(elems.len(), 1);
        match elems[0] {
            InfoElem::MeasValue(m) => {
                assert_eq!(m.ioa, 1003);
                assert!((m.value - 1.5).abs() < 1e-6);
                assert_eq!(m.quality.label(), "uncertain");
                assert_eq!(m.ts, None);
            }
            _ => panic!("wrong elem"),
        }
    }

    #[test]
    fn decode_m_me_tf_time() {
        let now = 1_700_000_000_000u64; // 2023-11-14T22:13:20Z
        let asdu = m_me_tf(1, 1003, -2.25, Quality::good(), COT_SPONTANEOUS, now);
        let elems = decode_info_elements(&asdu);
        match elems[0] {
            InfoElem::MeasValue(m) => {
                assert!((m.value + 2.25).abs() < 1e-6);
                let ts = m.ts.unwrap();
                let drift = (ts as i64 - now as i64).unsigned_abs();
                assert!(drift < 1000, "ts {} vs {}", ts, now);
            }
            _ => panic!("wrong elem"),
        }
    }

    #[test]
    fn cp56_time_roundtrip() {
        // CP56Time2a covers 2000..2099; ts=0 (1970) is clamped and must not be
        // round-tripped.
        for ts in [
            946_684_800_000u64,
            1_000_000_000_000u64,
            1_700_000_000_000u64,
            1_750_000_123_456u64,
        ] {
            let b = encode_cp56_time(ts);
            let back = decode_cp56_time(&b).unwrap();
            assert!(
                (back as i64 - ts as i64).unsigned_abs() < 2000,
                "{} -> {}",
                ts,
                back
            );
        }
    }

    #[test]
    fn cp56_time_encodes_now() {
        // Round-trip the current time (always in the 2000..2099 range).
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let b = encode_cp56_time(now);
        let back = decode_cp56_time(&b).unwrap();
        assert!((back as i64 - now as i64).unsigned_abs() < 2000);
    }

    #[test]
    fn cp56_time_invalid_bit() {
        let mut b = encode_cp56_time(1_700_000_000_000u64);
        b[5] |= 0x80;
        assert_eq!(decode_cp56_time(&b), None);
    }

    #[test]
    fn quality_labels() {
        assert_eq!(Quality::good().label(), "good");
        let bad = Quality {
            invalid: true,
            ..Quality::good()
        };
        assert_eq!(bad.label(), "bad");
        let unc = Quality {
            blocked: true,
            ..Quality::good()
        };
        assert_eq!(unc.label(), "uncertain");
        assert_eq!(Quality::from_siq(0x10).label(), "bad");
        assert_eq!(Quality::from_qds(0x01).label(), "uncertain");
        assert_eq!(Quality::from_diq(0x20).label(), "bad");
    }

    #[test]
    fn decode_f32_be_value() {
        assert!((decode_f32_be(&1.5f32.to_be_bytes()) - 1.5).abs() < 1e-6);
    }

    #[test]
    fn multi_object_asdu() {
        // Two M_SP_NA_1 objects in one ASDU.
        let mut info = Vec::new();
        for ioa in [10u32, 11] {
            info.extend_from_slice(&ioa_bytes(ioa));
            info.push(0x01);
        }
        let asdu = Asdu::new(TYPE_M_SP_NA_1, COT_INTERROGATED, false, 1, 2, info);
        let elems = decode_info_elements(&asdu);
        assert_eq!(elems.len(), 2);
        assert!(matches!(
            elems[0],
            InfoElem::SinglePoint(s) if s.ioa == 10 && s.value
        ));
        assert!(matches!(
            elems[1],
            InfoElem::SinglePoint(s) if s.ioa == 11 && s.value
        ));
    }

    #[test]
    fn truncated_payload() {
        let asdu = Asdu::new(
            TYPE_M_ME_NC_1,
            COT_INTERROGATED,
            false,
            1,
            2,
            vec![0xe9, 0x03, 0x00], // only one IOA, no value
        );
        assert!(decode_info_elements(&asdu).is_empty());
    }
}
