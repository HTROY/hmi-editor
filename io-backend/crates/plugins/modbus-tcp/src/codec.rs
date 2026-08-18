//! Modbus TCP 帧编解码（F18 ③：从 lib.rs 拆分）。

use plugin_kit::PointCfg;

pub const MBAP_PROTOCOL_ID: u16 = 0;
pub const MBAP_HEADER_LEN: usize = 7;

/// Build a Modbus TCP (MBAP) request frame.
pub fn build_request_frame(tid: u16, uid: u8, pdu: &[u8]) -> Vec<u8> {
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
pub fn parse_response(
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

pub fn hex_str(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<String>>()
        .join(" ")
}

pub fn split_addr(address: &str) -> Result<(&'static str, u16), String> {
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
pub enum WordOrder {
    Abcd,
    Badc,
    Cdab,
    Dcba,
}

pub fn word_order(byte_order: &str) -> WordOrder {
    match byte_order.trim().to_ascii_uppercase().as_str() {
        "BADC" => WordOrder::Badc,
        "CDAB" => WordOrder::Cdab,
        "DCBA" | "LITTLE" | "LITTLE_ENDIAN" => WordOrder::Dcba,
        _ => WordOrder::Abcd,
    }
}

pub fn is_32bit(dt: &str) -> bool {
    matches!(dt, "int32" | "uint32" | "float32")
}

pub fn decode_32(w0: u16, w1: u16, byte_order: &str) -> u32 {
    let b = [((w0 >> 8) as u8), (w0 as u8), ((w1 >> 8) as u8), (w1 as u8)];
    match word_order(byte_order) {
        WordOrder::Abcd => u32::from_be_bytes(b),
        WordOrder::Badc => u32::from_be_bytes([b[1], b[0], b[3], b[2]]),
        WordOrder::Cdab => u32::from_be_bytes([b[2], b[3], b[0], b[1]]),
        WordOrder::Dcba => u32::from_be_bytes([b[3], b[2], b[1], b[0]]),
    }
}

pub fn encode_32(value: u32, byte_order: &str) -> [u16; 2] {
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

pub fn decode_value(dt: &str, byte_order: &str, w0: u16, w1: u16) -> f64 {
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

pub fn encode_value(dt: &str, byte_order: &str, value: f64) -> Vec<u16> {
    match dt {
        "int16" => vec![(value as i16) as u16],
        "int32" => encode_32((value as i32) as u32, byte_order).to_vec(),
        "uint32" => encode_32(value as u32, byte_order).to_vec(),
        "float32" => encode_32((value as f32).to_bits(), byte_order).to_vec(),
        _ => vec![value as u16],
    }
}

/// 按点位配置解码寄存器值（含 scale/offset）。
pub fn decode_point(pt: &PointCfg, regs: &[u16]) -> f64 {
    let count = if is_32bit(&pt.data_type) { 2 } else { 1 };
    let w0 = regs.first().copied().unwrap_or(0);
    let w1 = if count == 2 {
        regs.get(1).copied().unwrap_or(0)
    } else {
        0
    };
    decode_value(&pt.data_type, &pt.byte_order, w0, w1) * pt.scale + pt.offset
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

    #[test]
    fn decode_point_applies_scale_offset() {
        let pt = PointCfg {
            variable_id: "x".into(),
            address: "holding_register:0".into(),
            var_type: "AI".into(),
            data_type: "uint16".into(),
            byte_order: String::new(),
            scale: 0.1,
            offset: 5.0,
        };
        assert_eq!(decode_point(&pt, &[100]), 15.0);
    }
}
