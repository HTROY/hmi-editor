//! OPC UA Protocol Plugin (Extism PDK)
use extism_pdk::*;
use serde::{Deserialize, Serialize};

#[link(wasm_import_module = "hmi")] extern "C" {
    fn host_now_ms() -> i64;
    fn host_log(level: i64, msg_off: i64);
    fn host_on_point(no: i64, v: f64, qo: i64, ts: i64);
    fn host_on_packet(do_: i64, po: i64, ho: i64, so: i64);
    fn host_tcp_connect(ho: i64, port: i64) -> i32;
    fn host_tcp_send(s: i64, do_: i64) -> i32;
    fn host_tcp_recv(s: i64, to: i64) -> i64;
    fn host_tcp_close(s: i64);
}

fn lm(l: i32, m: &str) { let x=Memory::from_bytes(m).expect("a"); unsafe{host_log(l as i64, x.offset() as i64);} }
fn rp(n: &str, v: f64, q: &str, ts: i64) { let nm=Memory::from_bytes(n).expect("a");let qm=Memory::from_bytes(q).expect("a");unsafe{host_on_point(nm.offset() as i64,v,qm.offset() as i64,ts);} }
fn rpt(dir: &str, p: &str, h: &str, s: &str) { let d=Memory::from_bytes(dir).expect("a");let pp=Memory::from_bytes(p).expect("a");let hh=Memory::from_bytes(h).expect("a");let ss=Memory::from_bytes(s).expect("a");unsafe{host_on_packet(d.offset() as i64,pp.offset() as i64,hh.offset() as i64,ss.offset() as i64);} }
fn tc(h: &str, p: i32) -> i32 { let m=Memory::from_bytes(h).expect("a"); unsafe{host_tcp_connect(m.offset() as i64, p as i64)} }
fn ts(s: i32, d: &[u8]) -> i32 { let m=Memory::from_bytes(d).expect("a"); unsafe{host_tcp_send(s as i64, m.offset() as i64)} }
fn tr(s: i32, to: i32) -> Vec<u8> { let off = unsafe{host_tcp_recv(s as i64, to as i64)}; if off > 0 { Memory::from(off as u64).to_vec() } else { Vec::new() } }
fn tcl(s: i32) { unsafe{host_tcp_close(s as i64);} }

#[derive(Debug,Clone,Serialize,Deserialize)] struct Pc { variable_id:String,address:String,var_type:String,#[serde(default)] data_type:String,#[serde(default)] byte_order:String,#[serde(default)] scale:f64,#[serde(default)] offset:f64 }
#[derive(Debug,Clone,Serialize,Deserialize)] struct Cfg { endpoint:String,#[serde(default)] points:Vec<Pc> }
#[derive(Debug,Clone,Serialize,Deserialize)] struct St { endpoint:String,connected:bool,scan_count:u64,socket:i32,points:Vec<Pc> }

fn sv(s:&St)->FnResult<()>{var::set("state",&serde_json::to_string(s)?)?;Ok(())}
fn ld() -> FnResult<Option<St>> {
    let json: Option<String> = var::get("state")?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

#[plugin_fn] pub fn plugin_init(Json(mut c):Json<Cfg>)->FnResult<i32>{lm(2,&format!("OPC UA init: {}, {} pts",c.endpoint,c.points.len()));sv(&St{endpoint:c.endpoint,connected:false,scan_count:0,socket:-1,points:std::mem::take(&mut c.points)})?;Ok(0)}
#[plugin_fn] pub fn plugin_connect()->FnResult<i32>{let mut s=ld()?.expect("ni");let h=s.endpoint.trim_start_matches("opc.tcp://").split(':').next().unwrap_or("127.0.0.1");let p=s.endpoint.split(':').last().and_then(|p|p.parse::<i32>().ok()).unwrap_or(4840);lm(2,&format!("OPC UA connecting {}:{}...",h,p));let sk=tc(h,p);if sk<0{lm(1,"connect failed");s.connected=false;sv(&s)?;return Ok(1);}let hello=build_hello(&s.endpoint);let hex: String = hello.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");rpt("tx","opcua",&hex,"TX: Hello");ts(sk,&hello);tr(sk,3000);s.connected=true;s.socket=sk;sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_disconnect()->FnResult<i32>{let mut s=ld()?.expect("ni");if s.socket>=0{tcl(s.socket);}s.connected=false;s.socket=-1;sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_scan_points()->FnResult<i32>{let mut s=ld()?.expect("ni");if!s.connected||s.socket<0{return Ok(1);}s.scan_count+=1;let now=unsafe{host_now_ms()};for pt in &s.points{rp(&pt.variable_id,0.0,"good",now);}sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_write_point(Json(i):Json<Wi>)->FnResult<i32>{let s=ld()?.expect("ni");if!s.connected||s.socket<0{return Ok(2);}lm(2,&format!("write {} = {}",i.name,i.value));Ok(0)}
#[plugin_fn] pub fn plugin_get_name()->FnResult<String>{Ok("OPC UA".to_string())}
#[plugin_fn] pub fn plugin_get_status()->FnResult<i32>{Ok(ld()?.map_or(0,|s|if s.connected{2}else{0}))}
#[derive(Deserialize)] struct Wi{name:String,value:f64}

fn build_hello(ep: &str) -> Vec<u8> {
    let eb=ep.as_bytes();let tl=32+eb.len() as u32;let mut m=Vec::with_capacity(tl as usize);
    m.extend_from_slice(b"HEL");m.push(b'F');m.extend_from_slice(&tl.to_le_bytes());
    m.extend_from_slice(&[0u8;4]);m.extend_from_slice(&65535u32.to_le_bytes());
    m.extend_from_slice(&65535u32.to_le_bytes());m.extend_from_slice(&[0u8;8]);m.extend_from_slice(eb);m
}
