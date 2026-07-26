//! IEC 60870-5-104 Protocol Plugin (Extism PDK)
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
#[derive(Debug,Clone,Serialize,Deserialize)] struct Cfg { host:String,port:u16,common_address:u16,#[serde(default)] points:Vec<Pc> }
#[derive(Debug,Clone,Serialize,Deserialize)] struct St { host:String,port:u16,common_address:u16,connected:bool,scan_count:u64,socket:i32,send_seq:u16,recv_seq:u16,points:Vec<Pc> }

fn sv(s:&St)->FnResult<()>{var::set("state",&serde_json::to_string(s)?)?;Ok(())}
fn ld() -> FnResult<Option<St>> {
    let json: Option<String> = var::get("state")?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

#[plugin_fn] pub fn plugin_init(Json(mut c):Json<Cfg>)->FnResult<i32>{lm(2,&format!("IEC104 init: {}:{}, CASDU={}, {} pts",c.host,c.port,c.common_address,c.points.len()));sv(&St{host:c.host,port:c.port,common_address:c.common_address,connected:false,scan_count:0,socket:-1,send_seq:0,recv_seq:0,points:std::mem::take(&mut c.points)})?;Ok(0)}
#[plugin_fn] pub fn plugin_connect()->FnResult<i32>{let mut s=ld()?.expect("ni");lm(2,&format!("IEC104 connecting {}:{}...",s.host,s.port));let sk=tc(&s.host,s.port as i32);if sk<0{lm(1,"connect failed");s.connected=false;sv(&s)?;return Ok(1);}let sd=build_startdt();let hex: String = sd.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");rpt("tx","iec104",&hex,"TX: STARTDT");ts(sk,&sd);tr(sk,3000);s.connected=true;s.socket=sk;sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_disconnect()->FnResult<i32>{let mut s=ld()?.expect("ni");if s.socket>=0{let sd=build_stopdt();ts(s.socket,&sd);tcl(s.socket);}s.connected=false;s.socket=-1;sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_scan_points()->FnResult<i32>{let mut s=ld()?.expect("ni");if!s.connected||s.socket<0{return Ok(1);}s.scan_count+=1;let now=unsafe{host_now_ms()};if s.scan_count%10==1{ts(s.socket,&build_ti(&s));}if s.scan_count%50==1{ts(s.socket,&build_cs(&s));}tr(s.socket,50);for pt in &s.points{rp(&pt.variable_id,0.0,"good",now);}s.send_seq=s.send_seq.wrapping_add(1);sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_write_point(Json(i):Json<Wi>)->FnResult<i32>{let mut s=ld()?.expect("ni");if!s.connected||s.socket<0{return Ok(2);}let a=s.points.iter().find(|p|p.variable_id==i.name).and_then(|p|p.address.parse::<u16>().ok()).unwrap_or(0);let cmd=build_sel(&mut s,a,i.value);ts(s.socket,&cmd);sv(&s)?;Ok(0)}
#[plugin_fn] pub fn plugin_get_name()->FnResult<String>{Ok("IEC 60870-5-104".to_string())}
#[plugin_fn] pub fn plugin_get_status()->FnResult<i32>{Ok(ld()?.map_or(0,|s|if s.connected{2}else{0}))}
#[derive(Deserialize)] struct Wi{name:String,value:f64}

fn build_startdt()->Vec<u8>{vec![0x68,0x04,0x07,0x00,0x00,0x00]}
fn build_stopdt()->Vec<u8>{vec![0x68,0x04,0x13,0x00,0x00,0x00]}
fn build_ti(s:&St)->Vec<u8>{let ss=s.send_seq;let rs=s.recv_seq;let c1=((ss<<1)&0xFE)as u8;let c2=(ss>>7)as u8;let c3=((rs<<1)&0xFE)as u8;let c4=(rs>>7)as u8;vec![0x68,14,c1,c2,c3,c4,0x64,0x01,0x06,0x00,(s.common_address>>8)as u8,(s.common_address&0xFF)as u8,0x00,0x00,0x00,0x14]}
fn build_cs(s:&St)->Vec<u8>{let ss=s.send_seq;let rs=s.recv_seq;let c1=((ss<<1)&0xFE)as u8;let c2=(ss>>7)as u8;let c3=((rs<<1)&0xFE)as u8;let c4=(rs>>7)as u8;let ns=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();let ms=ns.subsec_millis();let ts=[(ms&0xFF)as u8,((ms>>8)&0xFF)as u8,0,0,0,0,1,1,22];vec![0x68,15,c1,c2,c3,c4,0x67,0x01,0x06,0x00,(s.common_address>>8)as u8,(s.common_address&0xFF)as u8,0x00,0x00,0x00,ts[0],ts[1],ts[2],ts[3],ts[4],ts[5],ts[6]]}
fn build_sel(s:&mut St,ioa:u16,val:f64)->Vec<u8>{let ss=s.send_seq;s.send_seq=s.send_seq.wrapping_add(1);let rs=s.recv_seq;let c1=((ss<<1)&0xFE)as u8;let c2=(ss>>7)as u8;let c3=((rs<<1)&0xFE)as u8;let c4=(rs>>7)as u8;let sco=if val!=0.0{0x81}else{0x80};vec![0x68,15,c1,c2,c3,c4,0x2E,0x01,0x06,0x00,(s.common_address>>8)as u8,(s.common_address&0xFF)as u8,(ioa>>8)as u8,(ioa&0xFF)as u8,0x00,sco,0x00,0x00,0x00]}
