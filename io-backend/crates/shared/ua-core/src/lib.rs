//! Minimal OPC UA binary protocol codec (SecurityPolicy None).
//!
//! Pure `std` + `serde` so it compiles both for the `wasm32-wasip2` plugin
//! and for native test servers. Implements exactly what a read/write client
//! needs: HEL/ACK handshake, OpenSecureChannel, CreateSession, ActivateSession
//! (anonymous or username/password), Read, Write, CloseSession and
//! CloseSecureChannel. All integers are little-endian.
//!
//! Message layout (after the TCP handshake):
//! ```text
//! MessageHeader  : msgType[3] ('OPN'|'MSG'|'CLO') isFinal 'F'|'C' size u32
//! SecurityHeader : channelId u32 tokenId u32
//! SequenceHeader : sequenceNumber u32 requestId u32
//! Body           : ExpandedNodeId(service) + RequestHeader + params...
//! ```

use serde::{Deserialize, Serialize};

// 鈹€鈹€ Constants 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

pub const ATTR_VALUE: u32 = 13;
pub const STATUS_GOOD: u32 = 0x0000_0000;
/// Bad_NodeIdUnknown
pub const STATUS_BAD_NODE_ID_UNKNOWN: u32 = 0x8034_0000;
/// Bad_AttributeIdInvalid
pub const STATUS_BAD_ATTRIBUTE_ID_INVALID: u32 = 0x8035_0000;
/// Bad_NoAccess / Bad_UserAccessDenied
pub const STATUS_BAD_NO_ACCESS: u32 = 0x8033_0000;
/// Bad_UnexpectedError
pub const STATUS_BAD_UNEXPECTED_ERROR: u32 = 0x8001_0000;
/// Bad_ServiceUnsupported
pub const STATUS_BAD_SERVICE_UNSUPPORTED: u32 = 0x8004_0000;

// Service type ids (Request_Encoding_DefaultBinary / response variants).
pub const ID_OPEN_SECURE_CHANNEL_REQ: u32 = 446;
pub const ID_OPEN_SECURE_CHANNEL_RSP: u32 = 447;
pub const ID_CLOSE_SECURE_CHANNEL_REQ: u32 = 448;
pub const ID_CLOSE_SECURE_CHANNEL_RSP: u32 = 449;
pub const ID_CREATE_SESSION_REQ: u32 = 460;
pub const ID_CREATE_SESSION_RSP: u32 = 461;
pub const ID_ACTIVATE_SESSION_REQ: u32 = 466;
pub const ID_ACTIVATE_SESSION_RSP: u32 = 467;
pub const ID_CLOSE_SESSION_REQ: u32 = 472;
pub const ID_CLOSE_SESSION_RSP: u32 = 473;
pub const ID_READ_REQ: u32 = 630;
pub const ID_READ_RSP: u32 = 631;
pub const ID_WRITE_REQ: u32 = 672;
pub const ID_WRITE_RSP: u32 = 673;

// User identity token type ids.
pub const ID_ANONYMOUS_IDENTITY_TOKEN: u32 = 319;
pub const ID_USER_NAME_IDENTITY_TOKEN: u32 = 322;

/// Map a StatusCode to the HMI quality label.
pub fn status_quality(code: u32) -> &'static str {
    if code & 0x8000_0000 != 0 {
        "bad"
    } else if code & 0x4000_0000 != 0 {
        "uncertain"
    } else {
        "good"
    }
}

// 鈹€鈹€ DateTime (100ns since 1601-01-01) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const MS_BETWEEN_1601_1970: i64 = 11_644_473_600_000;

pub fn unix_ms_to_ua(ms: u64) -> i64 {
    (ms as i64 + MS_BETWEEN_1601_1970) * 10_000
}

pub fn ua_to_unix_ms(ua: i64) -> u64 {
    ((ua / 10_000) - MS_BETWEEN_1601_1970).max(0) as u64
}

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 鈹€鈹€ NodeId 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeIdValue {
    Numeric(u32),
    String(String),
    Guid([u8; 16]),
    ByteString(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeId {
    pub ns: u16,
    pub id: NodeIdValue,
}

impl NodeId {
    pub fn numeric(ns: u16, id: u32) -> Self {
        Self {
            ns,
            id: NodeIdValue::Numeric(id),
        }
    }

    pub fn string(ns: u16, id: &str) -> Self {
        Self {
            ns,
            id: NodeIdValue::String(id.to_string()),
        }
    }

    pub fn null() -> Self {
        Self::numeric(0, 0)
    }

    /// Parse an address-space node id string: `i=2258`, `ns=2;i=5`,
    /// `ns=2;s=Temperature.Zone1`, `s=Name`, `ns=2;g=<uuid>`,
    /// `ns=2;b=<hex>`, or a bare numeric string.
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (ns, rest) = if let Some(idx) = s.find("ns=") {
            let after = &s[idx + 3..];
            let ns_end = after.find([';', ',', ':']).unwrap_or(after.len());
            let ns: u16 = after[..ns_end]
                .parse()
                .map_err(|_| format!("bad namespace in '{}'", s))?;
            (ns, &after[ns_end..])
        } else {
            (0, s)
        };
        let rest = rest.trim_start_matches([';', ',', ':']);
        if rest.is_empty() {
            return Err(format!("empty node id in '{}'", s));
        }
        let id = if let Some(v) = rest.strip_prefix("i=") {
            NodeIdValue::Numeric(
                v.trim()
                    .parse()
                    .map_err(|_| format!("bad numeric id '{}'", s))?,
            )
        } else if let Some(v) = rest.strip_prefix("s=") {
            NodeIdValue::String(v.trim().to_string())
        } else if let Some(v) = rest.strip_prefix("g=") {
            let hex: String = v.trim().chars().filter(|c| *c != '-').collect();
            let raw = hex
                .as_bytes()
                .chunks(2)
                .map(|c| {
                    std::str::from_utf8(c)
                        .ok()
                        .and_then(|h| u8::from_str_radix(h, 16).ok())
                        .ok_or_else(|| format!("bad guid '{}'", s))
                })
                .collect::<Result<Vec<u8>, String>>()?;
            if raw.len() != 16 {
                return Err(format!("bad guid '{}'", s));
            }
            let mut g = [0u8; 16];
            g.copy_from_slice(&raw);
            NodeIdValue::Guid(g)
        } else if let Some(v) = rest.strip_prefix("b=") {
            let hex: String = v.trim().chars().filter(|c| !c.is_whitespace()).collect();
            let raw = hex
                .as_bytes()
                .chunks(2)
                .map(|c| {
                    std::str::from_utf8(c)
                        .ok()
                        .and_then(|h| u8::from_str_radix(h, 16).ok())
                        .ok_or_else(|| format!("bad bytestring '{}'", s))
                })
                .collect::<Result<Vec<u8>, String>>()?;
            NodeIdValue::ByteString(raw)
        } else if let Ok(v) = rest.parse::<u32>() {
            NodeIdValue::Numeric(v)
        } else {
            return Err(format!("unrecognized node id '{}'", s));
        };
        Ok(Self { ns, id })
    }
}

// 鈹€鈹€ Variant / DataValue 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum VariantValue {
    Boolean(bool),
    SByte(i8),
    Byte(u8),
    Int16(i16),
    UInt16(u16),
    Int32(i32),
    UInt32(u32),
    Int64(i64),
    UInt64(u64),
    Float(f32),
    Double(f64),
    String(String),
}

impl VariantValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            VariantValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
            VariantValue::SByte(v) => Some(*v as f64),
            VariantValue::Byte(v) => Some(*v as f64),
            VariantValue::Int16(v) => Some(*v as f64),
            VariantValue::UInt16(v) => Some(*v as f64),
            VariantValue::Int32(v) => Some(*v as f64),
            VariantValue::UInt32(v) => Some(*v as f64),
            VariantValue::Int64(v) => Some(*v as f64),
            VariantValue::UInt64(v) => Some(*v as f64),
            VariantValue::Float(v) => Some(*v as f64),
            VariantValue::Double(v) => Some(*v),
            VariantValue::String(_) => None,
        }
    }

    fn type_id(&self) -> u8 {
        match self {
            VariantValue::Boolean(_) => 1,
            VariantValue::SByte(_) => 2,
            VariantValue::Byte(_) => 3,
            VariantValue::Int16(_) => 4,
            VariantValue::UInt16(_) => 5,
            VariantValue::Int32(_) => 6,
            VariantValue::UInt32(_) => 7,
            VariantValue::Int64(_) => 8,
            VariantValue::UInt64(_) => 9,
            VariantValue::Float(_) => 10,
            VariantValue::Double(_) => 11,
            VariantValue::String(_) => 12,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataValue {
    pub value: Option<VariantValue>,
    pub status: u32,
    pub source_ts: i64,
    pub server_ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadValueId {
    pub node: NodeId,
    pub attribute_id: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteValue {
    pub node: NodeId,
    pub attribute_id: u32,
    pub value: Option<VariantValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateSessionResult {
    pub session_id: NodeId,
    pub auth_token: NodeId,
    pub revised_timeout: f64,
}

// 鈹€鈹€ Writer / Reader primitives 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }

    pub fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn i64(&mut self, v: i64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn bool(&mut self, v: bool) {
        self.u8(if v { 1 } else { 0 });
    }

    pub fn str_(&mut self, v: &str) {
        self.u32(v.len() as u32);
        self.buf.extend_from_slice(v.as_bytes());
    }

    pub fn bytes(&mut self, v: &[u8]) {
        self.u32(v.len() as u32);
        self.buf.extend_from_slice(v);
    }

    pub fn array_len(&mut self, n: usize) {
        self.u32(n as u32);
    }

    /// NodeId binary encoding (two/four-byte optimized where possible).
    pub fn node_id(&mut self, n: &NodeId) {
        match &n.id {
            NodeIdValue::Numeric(id) if n.ns == 0 && *id <= 255 => {
                self.u8(0x00);
                self.u8(*id as u8);
            }
            NodeIdValue::Numeric(id) if n.ns <= 255 && *id <= 0xffff => {
                self.u8(0x01);
                self.u8(n.ns as u8);
                self.u16(*id as u16);
            }
            NodeIdValue::Numeric(id) => {
                self.u8(0x02);
                self.u16(n.ns);
                self.u32(*id);
            }
            NodeIdValue::String(s) => {
                self.u8(0x03);
                self.u16(n.ns);
                self.str_(s);
            }
            NodeIdValue::Guid(g) => {
                self.u8(0x04);
                self.u16(n.ns);
                self.buf.extend_from_slice(g);
            }
            NodeIdValue::ByteString(b) => {
                self.u8(0x05);
                self.u16(n.ns);
                self.bytes(b);
            }
        }
    }

    /// ExpandedNodeId with server index / 32-bit namespace (not needed here).
    pub fn expanded_node_id(&mut self, n: &NodeId) {
        self.node_id(n);
    }

    pub fn extension_object_null(&mut self) {
        self.u8(0x00);
        self.u8(0x00);
    }

    pub fn extension_object(&mut self, type_id: u32, body: &[u8]) {
        // TypeId as a 4-byte numeric NodeId in namespace 0.
        self.u8(0x01);
        self.u8(0x00);
        self.u16(type_id as u16);
        self.u32(body.len() as u32);
        self.buf.extend_from_slice(body);
    }

    pub fn request_header(&mut self, auth_token: &NodeId, ts_ms: u64, handle: u32) {
        self.node_id(auth_token);
        self.i64(unix_ms_to_ua(ts_ms));
        self.u32(handle);
        self.u32(0); // returnDiagnostics
        self.str_(""); // auditEntryId
        self.u32(30_000); // timeoutHint
        self.extension_object_null(); // additionalHeader
    }

    pub fn variant(&mut self, v: &VariantValue) {
        self.u8(v.type_id());
        match v {
            VariantValue::Boolean(v) => self.bool(*v),
            VariantValue::SByte(v) => self.u8(*v as u8),
            VariantValue::Byte(v) => self.u8(*v),
            VariantValue::Int16(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::UInt16(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::Int32(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::UInt32(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::Int64(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::UInt64(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::Float(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::Double(v) => self.buf.extend_from_slice(&v.to_le_bytes()),
            VariantValue::String(v) => self.str_(v),
        }
    }

    pub fn data_value(&mut self, v: &DataValue) {
        match &v.value {
            Some(val) => self.variant(val),
            None => self.u8(0x00),
        }
        self.u32(v.status);
        self.i64(v.source_ts);
        self.u16(0);
        self.i64(v.server_ts);
        self.u16(0);
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.buf.len() {
            return Err(format!(
                "truncated: need {} bytes at {}, have {}",
                n,
                self.pos,
                self.buf.len()
            ));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub fn bool(&mut self) -> Result<bool, String> {
        Ok(self.u8()? != 0)
    }

    pub fn str_(&mut self) -> Result<String, String> {
        let len = self.u32()?;
        if len == 0xffff_ffff {
            return Ok(String::new());
        }
        if len > 10_000_000 {
            return Err(format!("string too long: {}", len));
        }
        let bytes = self.take(len as usize)?;
        String::from_utf8(bytes.to_vec()).map_err(|e| format!("bad utf8: {}", e))
    }

    pub fn bytes(&mut self) -> Result<Vec<u8>, String> {
        let len = self.u32()?;
        if len == 0xffff_ffff {
            return Ok(Vec::new());
        }
        if len > 10_000_000 {
            return Err(format!("bytestring too long: {}", len));
        }
        Ok(self.take(len as usize)?.to_vec())
    }

    pub fn array_len(&mut self, max: u32) -> Result<u32, String> {
        let n = self.u32()?;
        if n > max {
            return Err(format!("array too long: {}", n));
        }
        Ok(n)
    }

    pub fn node_id(&mut self) -> Result<NodeId, String> {
        let mask = self.u8()?;
        let (ns, id) = match mask {
            0x00 => (0, NodeIdValue::Numeric(self.u8()? as u32)),
            0x01 => (self.u8()? as u16, NodeIdValue::Numeric(self.u16()? as u32)),
            0x02 => (self.u16()?, NodeIdValue::Numeric(self.u32()?)),
            0x03 => (self.u16()?, NodeIdValue::String(self.str_()?)),
            0x04 => {
                let ns = self.u16()?;
                let g = self.take(16)?;
                let mut arr = [0u8; 16];
                arr.copy_from_slice(g);
                (ns, NodeIdValue::Guid(arr))
            }
            0x05 => (self.u16()?, NodeIdValue::ByteString(self.bytes()?)),
            _ => return Err(format!("unsupported node id mask 0x{:02x}", mask)),
        };
        Ok(NodeId { ns, id })
    }

    pub fn expanded_node_id(&mut self) -> Result<NodeId, String> {
        let mask = self.u8()?;
        let ns_field = mask & 0x08 != 0;
        let server_idx = mask & 0x10 != 0;
        let base = mask & 0x07;
        let mut n = match base {
            0x00 => NodeId::numeric(0, self.u8()? as u32),
            0x01 => NodeId::numeric(self.u8()? as u16, self.u16()? as u32),
            0x02 => NodeId::numeric(self.u16()?, self.u32()?),
            0x03 => NodeId::string(self.u16()?, &self.str_()?),
            0x04 => {
                let ns = self.u16()?;
                let g = self.take(16)?;
                let mut arr = [0u8; 16];
                arr.copy_from_slice(g);
                NodeId {
                    ns,
                    id: NodeIdValue::Guid(arr),
                }
            }
            0x05 => NodeId {
                ns: self.u16()?,
                id: NodeIdValue::ByteString(self.bytes()?),
            },
            _ => return Err(format!("unsupported expanded node id mask 0x{:02x}", mask)),
        };
        if ns_field {
            n.ns = self.u32()? as u16;
        }
        if server_idx {
            let _ = self.u32()?;
        }
        Ok(n)
    }

    pub fn extension_object(&mut self) -> Result<Option<(u32, Vec<u8>)>, String> {
        let type_id = self.expanded_node_id()?;
        let tid = match type_id.id {
            NodeIdValue::Numeric(v) => v,
            _ => return Err("extension object with non-numeric type id".to_string()),
        };
        if tid == 0 {
            return Ok(None);
        }
        let len = self.u32()?;
        if len > 10_000_000 {
            return Err(format!("extension object too long: {}", len));
        }
        Ok(Some((tid, self.take(len as usize)?.to_vec())))
    }

    pub fn variant(&mut self) -> Result<Option<VariantValue>, String> {
        let encoding = self.u8()?;
        let base = encoding & 0x3f;
        let is_array = encoding & 0x40 != 0;
        if is_array {
            // Arrays are not needed by the HMI; skip the elements.
            let n = self.array_len(10_000)?;
            for _ in 0..n {
                self.skip_variant_scalar(base)?;
            }
            return Ok(None);
        }
        self.read_variant_scalar(base)
    }

    fn skip_variant_scalar(&mut self, base: u8) -> Result<(), String> {
        match base {
            0 => Ok(()),
            1 => {
                self.u8()?;
                Ok(())
            }
            2 | 3 => {
                self.u8()?;
                Ok(())
            }
            4 | 5 => {
                self.u16()?;
                Ok(())
            }
            6 | 7 | 10 => {
                self.u32()?;
                Ok(())
            }
            8 | 9 | 11 => {
                self.i64()?;
                Ok(())
            }
            12 => {
                self.str_()?;
                Ok(())
            }
            _ => Err(format!("unsupported variant type id {}", base)),
        }
    }

    fn read_variant_scalar(&mut self, base: u8) -> Result<Option<VariantValue>, String> {
        match base {
            0 => Ok(None),
            1 => Ok(Some(VariantValue::Boolean(self.bool()?))),
            2 => Ok(Some(VariantValue::SByte(self.u8()? as i8))),
            3 => Ok(Some(VariantValue::Byte(self.u8()?))),
            4 => Ok(Some(VariantValue::Int16(self.u16()? as i16))),
            5 => Ok(Some(VariantValue::UInt16(self.u16()?))),
            6 => Ok(Some(VariantValue::Int32(self.u32()? as i32))),
            7 => Ok(Some(VariantValue::UInt32(self.u32()?))),
            8 => Ok(Some(VariantValue::Int64(self.i64()?))),
            9 => Ok(Some(VariantValue::UInt64(self.i64()? as u64))),
            10 => Ok(Some(VariantValue::Float(f32::from_le_bytes(
                self.take(4)?.try_into().unwrap(),
            )))),
            11 => Ok(Some(VariantValue::Double(self.f64()?))),
            12 => Ok(Some(VariantValue::String(self.str_()?))),
            _ => Err(format!("unsupported variant type id {}", base)),
        }
    }

    pub fn data_value(&mut self) -> Result<DataValue, String> {
        let value = self.variant()?;
        let status = self.u32()?;
        let source_ts = self.i64()?;
        let _source_pico = self.u16()?;
        let server_ts = self.i64()?;
        let _server_pico = self.u16()?;
        Ok(DataValue {
            value,
            status,
            source_ts,
            server_ts,
        })
    }

    pub fn signature_data(&mut self) -> Result<(), String> {
        let _alg = self.str_()?;
        let _sig = self.bytes()?;
        Ok(())
    }

    pub fn application_description(&mut self) -> Result<(), String> {
        let _uri = self.str_()?;
        let _product = self.str_()?;
        let _locale = self.str_()?;
        let _text = self.str_()?;
        let _kind = self.u32()?;
        let _gateway = self.str_()?;
        let _profile = self.str_()?;
        let n = self.array_len(1000)?;
        for _ in 0..n {
            let _ = self.str_()?;
        }
        Ok(())
    }

    pub fn user_token_policy(&mut self) -> Result<(), String> {
        let _policy_id = self.str_()?;
        let _token_type = self.u32()?;
        let _issued = self.str_()?;
        let _issuer = self.str_()?;
        let _uri = self.str_()?;
        Ok(())
    }

    pub fn endpoint_description(&mut self) -> Result<(), String> {
        let _url = self.str_()?;
        self.application_description()?;
        let _cert = self.bytes()?;
        let _mode = self.u32()?;
        let _policy = self.str_()?;
        let n = self.array_len(100)?;
        for _ in 0..n {
            self.user_token_policy()?;
        }
        let _transport = self.str_()?;
        let _level = self.u8()?;
        Ok(())
    }

    pub fn signed_software_certificate(&mut self) -> Result<(), String> {
        let _data = self.bytes()?;
        let _sig = self.bytes()?;
        Ok(())
    }

    /// Skip one DiagnosticInfo (nullable fields + optional inner info).
    pub fn skip_diagnostic_info(&mut self) -> Result<(), String> {
        let _symbolic = self.u32()?;
        let _ns = self.u32()?;
        let _locale = self.u32()?;
        let _localized = self.u32()?;
        let _info = self.str_()?;
        let _inner_status = self.u32()?;
        let inner_len = self.u32()?;
        if inner_len != 0xffff_ffff {
            if inner_len > 100_000 {
                return Err(format!("inner diagnostic too long: {}", inner_len));
            }
            let _ = self.take(inner_len as usize)?;
        }
        Ok(())
    }

    pub fn skip_diagnostic_infos(&mut self) -> Result<(), String> {
        let n = self.array_len(10_000)?;
        for _ in 0..n {
            self.skip_diagnostic_info()?;
        }
        Ok(())
    }
}

// 鈹€鈹€ Message framing 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingMessage {
    /// OPN / MSG / CLO with channelId/tokenId already stripped.
    Secure {
        token_id: u32,
        body: Vec<u8>,
    },
    Err {
        code: u32,
        reason: String,
    },
    Ack,
}

fn message_header(bytes: &[u8]) -> Result<(&[u8], usize), String> {
    if bytes.len() < 8 {
        return Err(format!("message too short: {} bytes", bytes.len()));
    }
    let msg_type = &bytes[0..3];
    if msg_type == b"HEL" || msg_type == b"ACK" || msg_type == b"ERR" {
        let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if size < 8 || size > bytes.len() {
            return Err(format!("bad message size: {}", size));
        }
        return Ok((&bytes[..size], size));
    }
    if msg_type == b"OPN" || msg_type == b"MSG" || msg_type == b"CLO" {
        let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        if size < 24 || size > bytes.len() {
            return Err(format!("bad secure message size: {}", size));
        }
        return Ok((&bytes[..size], size));
    }
    Err(format!("unknown message type {:?}", msg_type))
}

/// Split a byte buffer into complete messages (one or more frames).
pub fn split_messages(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (msg, size) = message_header(&bytes[pos..])?;
        out.push(msg.to_vec());
        pos += size;
    }
    Ok(out)
}

/// Parse a HEL/ACK/ERR handshake message.
pub fn parse_hello_message(bytes: &[u8]) -> Result<IncomingMessage, String> {
    let (msg, _) = message_header(bytes)?;
    match &msg[0..3] {
        b"ACK" => Ok(IncomingMessage::Ack),
        b"ERR" => {
            if msg.len() < 12 {
                return Err("short ERR message".to_string());
            }
            let code = u32::from_le_bytes(msg[8..12].try_into().unwrap());
            let mut r = Reader::new(&msg[12..]);
            let reason = r.str_().unwrap_or_default();
            Ok(IncomingMessage::Err { code, reason })
        }
        _ => Err("expected ACK or ERR".to_string()),
    }
}

/// Parse a secure (OPN/MSG/CLO) message, returning the body and token id.
pub fn parse_secure_message(bytes: &[u8]) -> Result<(u32, Vec<u8>), String> {
    let (msg, _) = message_header(bytes)?;
    if &msg[0..3] == b"ERR" {
        let code = u32::from_le_bytes(msg[8..12].try_into().unwrap());
        let mut r = Reader::new(&msg[12..]);
        let reason = r.str_().unwrap_or_default();
        return Err(format!("ERR {}: {}", code, reason));
    }
    if !matches!(&msg[0..3], b"OPN" | b"MSG" | b"CLO") {
        return Err(format!("expected secure message, got {:?}", &msg[0..3]));
    }
    let _channel_id = u32::from_le_bytes(msg[8..12].try_into().unwrap());
    let token_id = u32::from_le_bytes(msg[12..16].try_into().unwrap());
    let _seq = u32::from_le_bytes(msg[16..20].try_into().unwrap());
    let _request_id = u32::from_le_bytes(msg[20..24].try_into().unwrap());
    Ok((token_id, msg[24..].to_vec()))
}

/// Message envelope type ids for responses.
pub fn parse_service_body(bytes: &[u8]) -> Result<(u32, Vec<u8>), String> {
    let mut r = Reader::new(bytes);
    let type_id = r.expanded_node_id()?;
    let tid = match type_id.id {
        NodeIdValue::Numeric(v) => v,
        _ => return Err("service type id is not numeric".to_string()),
    };
    Ok((tid, bytes[r.pos..].to_vec()))
}

/// Parse a ResponseHeader (returns request handle + service status).
pub fn parse_response_header(r: &mut Reader) -> Result<(u32, u32), String> {
    let _ts = r.i64()?;
    let handle = r.u32()?;
    let status = r.u32()?;
    let _diag = r.u32()?;
    let n = r.array_len(1000)?;
    for _ in 0..n {
        let _ = r.str_()?;
    }
    let _ = r.extension_object()?;
    Ok((handle, status))
}

// 鈹€鈹€ Service bodies 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// Build the body of an OpenSecureChannelRequest.
pub fn build_opn_body(ts_ms: u64, handle: u32) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_OPEN_SECURE_CHANNEL_REQ));
    w.request_header(&NodeId::null(), ts_ms, handle);
    w.u32(0); // clientProtocolVersion
    w.u32(0); // requestType: Issue
    w.u32(1); // securityMode: None
    w.bytes(&[]); // clientNonce
    w.u32(3_600_000); // requestedLifetime
    w.into_bytes()
}

/// Parse an OpenSecureChannelResponse body (returns channel token lifetime).
pub fn parse_opn_body(bytes: &[u8]) -> Result<(u32, u32), String> {
    let mut r = Reader::new(bytes);
    let (_, status) = parse_response_header(&mut r)?;
    if status != STATUS_GOOD {
        return Err(format!("OPN rejected: 0x{:08x}", status));
    }
    let _protocol = r.u32()?;
    let channel_id = r.u32()?;
    let _token_id = r.u32()?;
    let _created = r.i64()?;
    let lifetime = r.u32()?;
    let _nonce = r.bytes()?;
    Ok((channel_id, lifetime))
}

/// Build the body of a CreateSessionRequest.
pub fn build_create_session_body(ts_ms: u64, handle: u32, endpoint: &str) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_CREATE_SESSION_REQ));
    w.request_header(&NodeId::null(), ts_ms, handle);
    // clientDescription: ApplicationDescription
    w.str_("urn:hmi-editor"); // applicationUri
    w.str_("hmi-editor"); // productUri
    w.str_("en"); // applicationName.locale
    w.str_("hmi-editor"); // applicationName.text
    w.u32(0); // applicationType: Client
    w.str_(""); // gatewayServerUri
    w.str_(""); // discoveryProfileUri
    w.array_len(0); // discoveryUrls
    w.str_(""); // serverUri
    w.str_(endpoint); // endpointUrl
    w.str_("hmi-editor"); // sessionName
    w.bytes(&[]); // clientNonce
    w.bytes(&[]); // clientCertificate
    w.f64(3_600_000.0); // requestedSessionTimeout
    w.u32(65_536); // maxResponseMessageSize
    w.into_bytes()
}

/// Parse a CreateSessionResponse body.
pub fn parse_create_session_body(bytes: &[u8]) -> Result<CreateSessionResult, String> {
    let mut r = Reader::new(bytes);
    let (_, status) = parse_response_header(&mut r)?;
    if status != STATUS_GOOD {
        return Err(format!("CreateSession failed: 0x{:08x}", status));
    }
    let session_id = r.node_id()?;
    let auth_token = r.node_id()?;
    let revised_timeout = r.f64()?;
    let _nonce = r.bytes()?;
    let _cert = r.bytes()?;
    let n = r.array_len(100)?;
    for _ in 0..n {
        r.endpoint_description()?;
    }
    let n = r.array_len(100)?;
    for _ in 0..n {
        r.signed_software_certificate()?;
    }
    r.signature_data()?;
    let _max = r.u32()?;
    Ok(CreateSessionResult {
        session_id,
        auth_token,
        revised_timeout,
    })
}

/// Build the body of an ActivateSessionRequest.
pub fn build_activate_session_body(
    ts_ms: u64,
    handle: u32,
    auth_token: &NodeId,
    username: Option<(&str, &str)>,
) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_ACTIVATE_SESSION_REQ));
    w.request_header(auth_token, ts_ms, handle);
    // clientSignature (empty)
    w.str_(""); // algorithm
    w.bytes(&[]); // signature
    w.array_len(0); // clientSoftwareCertificates
    w.array_len(0); // localeIds
    match username {
        None => {
            // AnonymousIdentityToken (policyId "Anonymous")
            let mut body = Writer::new();
            body.str_("Anonymous");
            w.extension_object(ID_ANONYMOUS_IDENTITY_TOKEN, &body.into_bytes());
        }
        Some((user, pass)) => {
            // UserNameIdentityToken (policyId "UsernamePassword")
            let mut body = Writer::new();
            body.str_("UsernamePassword");
            body.str_(user);
            body.bytes(pass.as_bytes());
            w.extension_object(ID_USER_NAME_IDENTITY_TOKEN, &body.into_bytes());
        }
    }
    // userTokenSignature (empty)
    w.str_("");
    w.bytes(&[]);
    w.into_bytes()
}

/// Parse an ActivateSessionResponse body; returns the service status.
pub fn parse_activate_session_body(bytes: &[u8]) -> Result<u32, String> {
    let mut r = Reader::new(bytes);
    let (_, status) = parse_response_header(&mut r)?;
    let _nonce = r.bytes()?;
    let n = r.array_len(1000)?;
    for _ in 0..n {
        let _ = r.u32()?;
    }
    r.skip_diagnostic_infos()?;
    Ok(status)
}

/// Build the body of a ReadRequest.
pub fn build_read_body(
    ts_ms: u64,
    handle: u32,
    auth_token: &NodeId,
    nodes: &[ReadValueId],
) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_READ_REQ));
    w.request_header(auth_token, ts_ms, handle);
    w.f64(0.0); // maxAge
    w.u32(0); // timestampsToReturn: Neither
    w.array_len(nodes.len());
    for n in nodes {
        w.expanded_node_id(&n.node);
        w.u32(n.attribute_id);
        w.str_(""); // indexRange
        w.u16(0); // dataEncoding: QualifiedName ns
        w.str_(""); // dataEncoding: name
    }
    w.into_bytes()
}

/// Parse a ReadResponse body into per-node DataValues.
pub fn parse_read_body(bytes: &[u8]) -> Result<Vec<DataValue>, String> {
    let mut r = Reader::new(bytes);
    let (_, status) = parse_response_header(&mut r)?;
    if status != STATUS_GOOD {
        return Err(format!("Read failed: 0x{:08x}", status));
    }
    let n = r.array_len(10_000)?;
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        out.push(r.data_value()?);
    }
    r.skip_diagnostic_infos()?;
    Ok(out)
}

/// Build the body of a WriteRequest.
pub fn build_write_body(
    ts_ms: u64,
    handle: u32,
    auth_token: &NodeId,
    writes: &[WriteValue],
) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_WRITE_REQ));
    w.request_header(auth_token, ts_ms, handle);
    w.array_len(writes.len());
    for wv in writes {
        w.expanded_node_id(&wv.node);
        w.u32(wv.attribute_id);
        w.str_(""); // indexRange
        w.data_value(&DataValue {
            value: wv.value.clone(),
            status: STATUS_GOOD,
            source_ts: unix_ms_to_ua(now_unix_ms()),
            server_ts: unix_ms_to_ua(now_unix_ms()),
        });
    }
    w.into_bytes()
}

/// Parse a WriteResponse body into per-node status codes.
pub fn parse_write_body(bytes: &[u8]) -> Result<Vec<u32>, String> {
    let mut r = Reader::new(bytes);
    let (_, status) = parse_response_header(&mut r)?;
    if status != STATUS_GOOD {
        return Err(format!("Write failed: 0x{:08x}", status));
    }
    let n = r.array_len(10_000)?;
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        out.push(r.u32()?);
    }
    r.skip_diagnostic_infos()?;
    Ok(out)
}

/// Build the body of a CloseSessionRequest.
pub fn build_close_session_body(ts_ms: u64, handle: u32, auth_token: &NodeId) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_CLOSE_SESSION_REQ));
    w.request_header(auth_token, ts_ms, handle);
    w.bool(true); // deleteSubscriptions
    w.into_bytes()
}

/// Build the body of a CloseSecureChannelRequest.
pub fn build_close_channel_body(ts_ms: u64, handle: u32) -> Vec<u8> {
    let mut w = Writer::new();
    w.expanded_node_id(&NodeId::numeric(0, ID_CLOSE_SECURE_CHANNEL_REQ));
    w.request_header(&NodeId::null(), ts_ms, handle);
    w.into_bytes()
}

// 鈹€鈹€ Tests 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_parse_variants() {
        assert_eq!(NodeId::parse("i=2258").unwrap(), NodeId::numeric(0, 2258));
        assert_eq!(NodeId::parse("ns=2;i=5").unwrap(), NodeId::numeric(2, 5));
        assert_eq!(
            NodeId::parse("ns=2;s=Temperature.Zone1").unwrap(),
            NodeId::string(2, "Temperature.Zone1")
        );
        assert_eq!(NodeId::parse("s=Name").unwrap(), NodeId::string(0, "Name"));
        assert_eq!(NodeId::parse("123").unwrap(), NodeId::numeric(0, 123));
        assert!(NodeId::parse("ns=2").is_err());
        assert!(NodeId::parse("").is_err());
    }

    #[test]
    fn node_id_roundtrip() {
        let cases = [
            NodeId::numeric(0, 2258),
            NodeId::numeric(2, 5),
            NodeId::numeric(0, 100),
            NodeId::string(2, "Temperature.Zone1"),
            NodeId::string(0, "Name"),
            NodeId::numeric(1, 65535),
            NodeId::numeric(3, 70000),
        ];
        for n in &cases {
            let mut w = Writer::new();
            w.node_id(n);
            let bytes = w.into_bytes();
            let mut r = Reader::new(&bytes);
            assert_eq!(&r.node_id().unwrap(), n);
        }
    }

    #[test]
    fn node_id_encodings() {
        let mut w = Writer::new();
        w.node_id(&NodeId::numeric(0, 5));
        assert_eq!(w.into_bytes(), [0x00, 0x05]);
        let mut w = Writer::new();
        w.node_id(&NodeId::numeric(2, 5));
        assert_eq!(w.into_bytes(), [0x01, 0x02, 0x05, 0x00]);
        let mut w = Writer::new();
        w.node_id(&NodeId::string(2, "AB"));
        assert_eq!(
            w.into_bytes(),
            [0x03, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, b'A', b'B']
        );
    }

    #[test]
    fn ua_datetime_conversion() {
        // 1970-01-01T00:00:00Z == 11644473600s after 1601-01-01.
        assert_eq!(unix_ms_to_ua(0), 116_444_736_000_000_000);
        assert_eq!(ua_to_unix_ms(116_444_736_000_000_000), 0);
        let now = now_unix_ms();
        let round = ua_to_unix_ms(unix_ms_to_ua(now));
        assert!((round as i64 - now as i64).unsigned_abs() < 2);
    }

    #[test]
    fn variant_roundtrip() {
        let cases = vec![
            VariantValue::Boolean(true),
            VariantValue::Int16(-12),
            VariantValue::UInt32(4000000000),
            VariantValue::Int64(-1_234_567_890),
            VariantValue::Float(1.5),
            VariantValue::Double(3.14159),
            VariantValue::String("hello".to_string()),
            VariantValue::Byte(7),
        ];
        for v in cases {
            let mut w = Writer::new();
            w.variant(&v);
            let bytes = w.into_bytes();
            let mut r = Reader::new(&bytes);
            assert_eq!(r.variant().unwrap(), Some(v.clone()));
        }
        // Null variant
        let mut w = Writer::new();
        w.u8(0x00);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        assert_eq!(r.variant().unwrap(), None);
    }

    #[test]
    fn data_value_roundtrip() {
        let dv = DataValue {
            value: Some(VariantValue::Double(42.5)),
            status: STATUS_GOOD,
            source_ts: unix_ms_to_ua(1_700_000_000_000),
            server_ts: unix_ms_to_ua(1_700_000_000_500),
        };
        let mut w = Writer::new();
        w.data_value(&dv);
        let bytes = w.into_bytes();
        let mut r = Reader::new(&bytes);
        let back = r.data_value().unwrap();
        assert_eq!(back.value, dv.value);
        assert_eq!(back.status, STATUS_GOOD);
        assert_eq!(back.source_ts, dv.source_ts);
    }

    #[test]
    fn read_body_structure() {
        let nodes = vec![
            ReadValueId {
                node: NodeId::string(2, "Temperature.Zone1"),
                attribute_id: ATTR_VALUE,
            },
            ReadValueId {
                node: NodeId::numeric(0, 2258),
                attribute_id: ATTR_VALUE,
            },
        ];
        let body = build_read_body(1_700_000_000_000, 42, &NodeId::numeric(0, 5), &nodes);
        let mut r = Reader::new(&body);
        assert_eq!(
            r.expanded_node_id().unwrap(),
            NodeId::numeric(0, ID_READ_REQ)
        );
        // Request header: authToken + ts + handle + returnDiag + audit + timeout
        // + additionalHeader.
        assert_eq!(r.node_id().unwrap(), NodeId::numeric(0, 5));
        let _ts = r.i64().unwrap();
        assert_eq!(r.u32().unwrap(), 42);
        assert_eq!(r.u32().unwrap(), 0); // returnDiagnostics
        let _audit = r.str_().unwrap();
        let _timeout = r.u32().unwrap();
        let _additional = r.extension_object().unwrap();
        let _max_age = r.f64().unwrap();
        assert_eq!(r.u32().unwrap(), 0); // timestampsToReturn
        assert_eq!(r.array_len(1000).unwrap(), 2);
        let n1 = r.expanded_node_id().unwrap();
        assert_eq!(n1, NodeId::string(2, "Temperature.Zone1"));
        assert_eq!(r.u32().unwrap(), ATTR_VALUE);
        let _index = r.str_().unwrap();
        assert_eq!(r.u16().unwrap(), 0); // dataEncoding ns
        let _name = r.str_().unwrap();
        let n2 = r.expanded_node_id().unwrap();
        assert_eq!(n2, NodeId::numeric(0, 2258));
        assert_eq!(r.u32().unwrap(), ATTR_VALUE);
        let _index2 = r.str_().unwrap();
        assert_eq!(r.u16().unwrap(), 0); // dataEncoding ns
        let _name2 = r.str_().unwrap();
        assert_eq!(r.remaining(), 0);
    }

    #[test]
    fn write_body_structure() {
        let writes = vec![WriteValue {
            node: NodeId::string(2, "Temp.Zone1.Set"),
            attribute_id: ATTR_VALUE,
            value: Some(VariantValue::Double(23.5)),
        }];
        let body = build_write_body(1_700_000_000_000, 7, &NodeId::numeric(0, 5), &writes);
        let mut r = Reader::new(&body);
        assert_eq!(
            r.expanded_node_id().unwrap(),
            NodeId::numeric(0, ID_WRITE_REQ)
        );
        let _auth = r.node_id().unwrap();
        let _ts = r.i64().unwrap();
        let handle = r.u32().unwrap();
        assert_eq!(handle, 7);
        let _return_diag = r.u32().unwrap();
        let _audit = r.str_().unwrap();
        let _timeout = r.u32().unwrap();
        let _additional = r.extension_object().unwrap();
        assert_eq!(r.array_len(1000).unwrap(), 1);
        let _node = r.expanded_node_id().unwrap();
        assert_eq!(r.u32().unwrap(), ATTR_VALUE);
        let _idx = r.str_().unwrap();
        let dv = r.data_value().unwrap();
        assert_eq!(dv.value, Some(VariantValue::Double(23.5)));
    }

    #[test]
    fn split_messages_frames() {
        let a = vec![0x41u8, 0x43, 0x4b, 0x46, 0x08, 0x00, 0x00, 0x00];
        let b = vec![0x41u8, 0x43, 0x4b, 0x46, 0x08, 0x00, 0x00, 0x00];
        let mut buf = a.clone();
        buf.extend_from_slice(&b);
        let msgs = split_messages(&buf).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(parse_hello_message(&msgs[0]).unwrap(), IncomingMessage::Ack);
    }

    #[test]
    fn parse_err_message() {
        let mut w = Writer::new();
        w.u32(0x8004_0000); // Bad_ServiceUnsupported
        w.str_("nope");
        let body = w.into_bytes();
        let mut msg = b"ERRF".to_vec();
        msg.extend_from_slice(&((body.len() + 8) as u32).to_le_bytes());
        msg.extend_from_slice(&body);
        match parse_hello_message(&msg).unwrap() {
            IncomingMessage::Err { code, reason } => {
                assert_eq!(code, 0x8004_0000);
                assert_eq!(reason, "nope");
            }
            _ => panic!("expected ERR"),
        }
    }

    #[test]
    fn status_quality_mapping() {
        assert_eq!(status_quality(0), "good");
        assert_eq!(status_quality(0x4000_0000), "uncertain");
        assert_eq!(status_quality(0x8000_0000), "bad");
    }
}
