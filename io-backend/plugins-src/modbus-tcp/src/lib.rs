//! Modbus TCP Protocol Plugin (Extism PDK)
use extism_pdk::*;
use serde::{Deserialize, Serialize};

#[link(wasm_import_module = "hmi")]
extern "C" {
    fn host_now_ms() -> i64;
    fn host_log(level: i64, msg_off: i64);
    fn host_on_point(no: i64, v: f64, qo: i64, ts: i64);
    fn host_on_packet(do_: i64, po: i64, ho: i64, so: i64);
    fn host_tcp_connect(ho: i64, port: i64) -> i32;
    fn host_tcp_send(s: i64, do_: i64) -> i32;
    fn host_tcp_recv(s: i64, to: i64) -> i64;
    fn host_tcp_close(s: i64);
    fn host_udp_bind(port: i64) -> i32;
    fn host_udp_send(s: i64, ho: i64, port: i64, do_: i64) -> i32;
    fn host_udp_recv(s: i64, to: i64) -> i64;
    fn host_udp_close(s: i64);
}

fn lm(l: i32, m: &str) {
    let x = Memory::from_bytes(m).expect("a");
    unsafe {
        host_log(l as i64, x.offset() as i64);
    }
}
fn rp(n: &str, v: f64, q: &str, ts: i64) {
    let nm = Memory::from_bytes(n).expect("a");
    let qm = Memory::from_bytes(q).expect("a");
    unsafe {
        host_on_point(nm.offset() as i64, v, qm.offset() as i64, ts);
    }
}
fn rpt(dir: &str, p: &str, h: &str, s: &str) {
    let d = Memory::from_bytes(dir).expect("a");
    let pp = Memory::from_bytes(p).expect("a");
    let hh = Memory::from_bytes(h).expect("a");
    let ss = Memory::from_bytes(s).expect("a");
    unsafe {
        host_on_packet(
            d.offset() as i64,
            pp.offset() as i64,
            hh.offset() as i64,
            ss.offset() as i64,
        );
    }
}
fn tc(h: &str, p: i32) -> i32 {
    let m = Memory::from_bytes(h).expect("a");
    unsafe { host_tcp_connect(m.offset() as i64, p as i64) }
}
fn ts(s: i32, d: &[u8]) -> i32 {
    let m = Memory::from_bytes(d).expect("a");
    unsafe { host_tcp_send(s as i64, m.offset() as i64) }
}
fn tr(s: i32, to: i32) -> Vec<u8> {
    let off = unsafe { host_tcp_recv(s as i64, to as i64) };
    if off > 0 {
        Memory::from(off as u64).to_vec()
    } else {
        Vec::new()
    }
}
fn tcl(s: i32) {
    unsafe {
        host_tcp_close(s as i64);
    }
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
    socket: i32,
    points: Vec<Pc>,
}

fn sv(s: &PluginState) -> FnResult<()> {
    var::set("state", &serde_json::to_string(s)?)?;
    Ok(())
}
fn ld() -> FnResult<Option<PluginState>> {
    let json: Option<String> = var::get("state")?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

#[plugin_fn]
pub fn plugin_init(Json(mut c): Json<PluginConfig>) -> FnResult<i32> {
    lm(
        2,
        &format!(
            "Modbus TCP init: {}:{}, slave={}, {} pts",
            c.host,
            c.port,
            c.slave_id,
            c.points.len()
        ),
    );
    sv(&PluginState {
        host: c.host,
        port: c.port,
        slave_id: c.slave_id,
        connected: false,
        scan_count: 0,
        socket: -1,
        points: std::mem::take(&mut c.points),
    })?;
    Ok(0)
}
#[plugin_fn]
pub fn plugin_connect() -> FnResult<i32> {
    let mut s = ld()?.expect("ni");
    lm(
        2,
        &format!("Modbus TCP connecting {}:{}...", s.host, s.port),
    );
    let sk = tc(&s.host, s.port as i32);
    if sk < 0 {
        lm(1, "connect failed");
        s.connected = false;
        s.socket = -1;
        sv(&s)?;
        return Ok(1);
    }
    s.connected = true;
    s.socket = sk;
    lm(2, &format!("connected fd={}", sk));
    sv(&s)?;
    Ok(0)
}
#[plugin_fn]
pub fn plugin_disconnect() -> FnResult<i32> {
    let mut s = ld()?.expect("ni");
    if s.socket >= 0 {
        tcl(s.socket);
    }
    s.connected = false;
    s.socket = -1;
    sv(&s)?;
    Ok(0)
}
#[plugin_fn]
pub fn plugin_scan_points() -> FnResult<i32> {
    let mut s = ld()?.expect("ni");
    if !s.connected || s.socket < 0 {
        return Ok(1);
    }
    s.scan_count += 1;
    let now = unsafe { host_now_ms() };
    for pt in &s.points.clone() {
        match mb_read(&s, pt) {
            Ok(v) => {
                rp(&pt.variable_id, v, "good", now);
            }
            Err(e) => {
                rp(&pt.variable_id, 0.0, "bad", now);
                lm(1, &e);
            }
        }
    }
    sv(&s)?;
    Ok(0)
}

fn mb_read(state: &PluginState, pt: &Pc) -> Result<f64, String> {
    let (fc, addr): (u8, u16) = if pt.address.starts_with("coil:") {
        (
            0x01,
            pt.address[5..]
                .parse::<u16>()
                .map_err(|e| format!("bad addr: {}", e))?,
        )
    } else if pt.address.starts_with("holding_register:") {
        (
            0x03,
            pt.address[17..]
                .parse::<u16>()
                .map_err(|e| format!("bad addr: {}", e))?,
        )
    } else if pt.address.starts_with("input_register:") {
        (
            0x04,
            pt.address[15..]
                .parse::<u16>()
                .map_err(|e| format!("bad addr: {}", e))?,
        )
    } else if pt.address.starts_with("discrete_input:") {
        (
            0x02,
            pt.address[14..]
                .parse::<u16>()
                .map_err(|e| format!("bad addr: {}", e))?,
        )
    } else {
        return Err(format!("unknown addr type: {}", pt.address));
    };

    let mut frame = vec![0u8; 12];
    frame[0] = ((state.scan_count >> 8) & 0xff) as u8;
    frame[1] = (state.scan_count & 0xff) as u8;
    frame[2] = 0;
    frame[3] = 0;
    frame[4] = 0;
    frame[5] = 6;
    frame[6] = state.slave_id;
    frame[7] = fc;
    frame[8] = ((addr >> 8) & 0xff) as u8;
    frame[9] = (addr & 0xff) as u8;
    frame[10] = 0;
    frame[11] = 1;

    let hex_dump: String = frame
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(" ");
    let summary = format!(
        "{} addr={} count=1",
        if fc == 0x01 {
            "RD_COIL"
        } else if fc == 0x03 {
            "RD_HREG"
        } else if fc == 0x02 {
            "RD_DIN"
        } else {
            "RD_IREG"
        },
        addr
    );
    rpt("tx", "modbus", &hex_dump, &summary);

    let sent = ts(state.socket, &frame);
    if sent < 0 {
        return Err("send failed".into());
    }

    let data = tr(state.socket, 2000);
    if data.is_empty() {
        return Err("recv timeout".into());
    }
    if data.len() < 9 {
        return Err(format!("short resp: {} bytes", data.len()));
    }

    let rx_hex: String = data
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(" ");
    rpt("rx", "modbus", &rx_hex, "response");

    if data[7] != fc {
        return Err(format!("bad fc: {}", data[7]));
    }

    let raw: f64 = match fc {
        0x01 | 0x02 => {
            if data.len() < 10 || data[8] < 1 {
                return Err("empty coil data".into());
            }
            ((data[9] & 0x01) as f64)
        }
        0x03 | 0x04 => {
            if data.len() < 10 || data[8] < 2 {
                return Err("empty register data".into());
            }
            let hi = data[9] as u16;
            let lo = data[10] as u16;
            ((hi << 8) | lo) as f64
        }
        _ => return Err(format!("unsupported fc: {}", fc)),
    };

    let val = raw * pt.scale + pt.offset;
    Ok(val)
}
#[plugin_fn]
pub fn plugin_write_point(Json(i): Json<Wi>) -> FnResult<i32> {
    let s = ld()?.expect("ni");
    if !s.connected || s.socket < 0 {
        return Ok(2);
    }
    let pt = s.points.iter().find(|p| p.variable_id == i.name).cloned();
    if pt.is_none() {
        return Ok(3);
    }
    let pt = pt.unwrap();
    let (fc, addr): (u8, u16) = if pt.address.starts_with("coil:") {
        (
            0x05,
            pt.address[5..]
                .parse::<u16>()
                .map_err(|_| "bad addr".to_string())
                .unwrap_or(0),
        )
    } else if pt.address.starts_with("holding_register:") {
        (
            0x06,
            pt.address[17..]
                .parse::<u16>()
                .map_err(|_| "bad addr".to_string())
                .unwrap_or(0),
        )
    } else {
        return Ok(3);
    };

    let mut frame = vec![0u8; 12];
    frame[0] = ((s.scan_count >> 8) & 0xff) as u8;
    frame[1] = (s.scan_count & 0xff) as u8;
    frame[2] = 0;
    frame[3] = 0;
    frame[4] = 0;
    frame[5] = 6;
    frame[6] = s.slave_id;
    frame[7] = fc;
    frame[8] = ((addr >> 8) & 0xff) as u8;
    frame[9] = (addr & 0xff) as u8;
    let v = i.value as u16;
    frame[10] = ((v >> 8) & 0xff) as u8;
    frame[11] = (v & 0xff) as u8;

    let hex_dump: String = frame
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(" ");
    rpt(
        "tx",
        "modbus",
        &hex_dump,
        &format!("WRITE {}={}", pt.address, i.value),
    );
    let sent = ts(s.socket, &frame);
    if sent < 0 {
        return Ok(4);
    }

    let data = tr(s.socket, 2000);
    if data.len() < 9 {
        return Ok(5);
    }
    lm(2, &format!("write {}={} done", i.name, i.value));
    Ok(0)
}
#[plugin_fn]
pub fn plugin_get_name() -> FnResult<String> {
    Ok("Modbus TCP".to_string())
}
#[plugin_fn]
pub fn plugin_get_status() -> FnResult<i32> {
    Ok(ld()?.map_or(0, |s| if s.connected { 2 } else { 0 }))
}
#[derive(Deserialize)]
struct Wi {
    name: String,
    value: f64,
}
