//! IEC 60870-5-104 slave simulator for end-to-end testing.
//!
//! Listens on 127.0.0.1:2404, answers STARTDT/TESTFR U-frames, replies to
//! general interrogation (C_IC_NA_1) and clock sync (C_CS_NA_1), executes
//! single/float commands (C_SC_NA_1 / C_SE_NC_1) with ACT_CON/ACT_TERM, and
//! pushes spontaneous measurements (COT_SPONTANEOUS) once per second.
//!
//! Point set (mirrors io-backend/config.yaml):
//!   IOA 1001/1002 bool   ACB status (toggles every 5 s)
//!   IOA 1003/1004 float  currents (sine)
//!   IOA 1005      float  bus voltage (sine + offset)
//!   IOA 3001      bool   fan status (toggles every 7 s)
//!   IOA 3002      float  fan speed (ramps 0..100)
use iec104_core::{
    encode_i, encode_s, encode_u, m_me_nc, m_sp, parse_apdu, Apdu, Asdu, UFrame, COT_ACT_CON,
    COT_ACT_TERM, COT_INTERROGATED, COT_SPONTANEOUS, TYPE_C_CS_NA_1, TYPE_C_IC_NA_1,
    TYPE_C_SC_NA_1, TYPE_C_SE_NC_1,
};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const PORT: u16 = 2404;

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Float,
}

#[derive(Clone, Copy)]
struct Point {
    ioa: u16,
    kind: Kind,
    value: f64,
}

impl Point {
    fn bool(ioa: u16, on: bool) -> Self {
        Self {
            ioa,
            kind: Kind::Bool,
            value: if on { 1.0 } else { 0.0 },
        }
    }
    fn float(ioa: u16, v: f64) -> Self {
        Self {
            ioa,
            kind: Kind::Float,
            value: v,
        }
    }
}

struct Slave {
    ca: u16,
    send_seq: u16,
    recv_seq: u16,
    points: Vec<Point>,
    started: bool,
    last_push: Instant,
}

impl Slave {
    fn new() -> Self {
        Self {
            ca: 1,
            send_seq: 0,
            recv_seq: 0,
            points: vec![
                Point::bool(1001, false),
                Point::bool(1002, false),
                Point::float(1003, 0.0),
                Point::float(1004, 0.0),
                Point::float(1005, 0.0),
                Point::bool(3001, false),
                Point::float(3002, 0.0),
            ],
            started: false,
            last_push: Instant::now(),
        }
    }

    fn update_sim(&mut self, elapsed: f64) {
        let toggled = |base: f64, period: f64| -> f64 {
            if ((elapsed + base) % period) < period / 2.0 {
                1.0
            } else {
                0.0
            }
        };
        for p in &mut self.points {
            match (p.ioa, p.kind) {
                (1001, Kind::Bool) => p.value = toggled(0.0, 5.0),
                (1002, Kind::Bool) => p.value = toggled(2.5, 5.0),
                (3001, Kind::Bool) => p.value = toggled(0.0, 7.0),
                (1003, Kind::Float) => p.value = 120.0 * (elapsed / 4.0).sin(),
                (1004, Kind::Float) => p.value = 80.0 * (elapsed / 3.0).cos(),
                (1005, Kind::Float) => p.value = 400.0 + 25.0 * (elapsed / 6.0).sin(),
                (3002, Kind::Float) => p.value = (elapsed * 10.0) % 100.0,
                _ => {}
            }
        }
    }

    fn send(&mut self, stream: &mut TcpStream, frame: &[u8], what: &str) {
        let hex: String = frame
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        println!("TX {}: {}", what, hex);
        if let Err(e) = stream.write_all(frame) {
            eprintln!("send error: {}", e);
        }
    }

    fn push_all(&mut self, stream: &mut TcpStream, cot: u8) {
        let frames: Vec<Vec<u8>> = self
            .points
            .iter()
            .map(|p| {
                let asdu: Asdu = match p.kind {
                    Kind::Bool => m_sp(
                        self.ca,
                        p.ioa as u32,
                        p.value != 0.0,
                        iec104_core::Quality::good(),
                        cot,
                    ),
                    Kind::Float => m_me_nc(
                        self.ca,
                        p.ioa as u32,
                        p.value as f32,
                        iec104_core::Quality::good(),
                        cot,
                    ),
                };
                let f = encode_i(self.send_seq, self.recv_seq, &asdu);
                f
            })
            .collect();
        for f in &frames {
            self.send_seq = self.send_seq.wrapping_add(1);
            self.send(stream, f, "I/meas");
        }
    }
    fn handle(&mut self, stream: &mut TcpStream, frame: &[u8]) {
        let apdu = match parse_apdu(frame) {
            Ok(a) => a,
            Err(e) => {
                println!("bad APDU: {}", e);
                return;
            }
        };
        match apdu {
            Apdu::U {
                frame: UFrame::StartDt,
                confirm: false,
            } => {
                println!("RX STARTDT");
                let reply = encode_u(UFrame::StartDt, true);
                self.send(stream, &reply, "U/STARTDT_CON");
                self.started = true;
            }
            Apdu::U {
                frame: UFrame::TestFr,
                confirm: false,
            } => {
                println!("RX TESTFR");
                let reply = encode_u(UFrame::TestFr, true);
                self.send(stream, &reply, "U/TESTFR_CON");
            }
            Apdu::U {
                frame: UFrame::StopDt,
                confirm: false,
            } => {
                println!("RX STOPDT");
                let reply = encode_u(UFrame::StopDt, true);
                self.send(stream, &reply, "U/STOPDT_CON");
            }
            Apdu::U { confirm: true, .. } => {
                println!("RX U-frame confirm");
            }
            Apdu::S { .. } => println!("RX S-frame (ack)"),
            Apdu::I { send_seq, asdu, .. } => {
                self.recv_seq = self.recv_seq.max(send_seq.wrapping_add(1));
                println!(
                    "RX I#{} t{} cot{} ca{} num{}",
                    send_seq, asdu.type_id, asdu.cot, asdu.ca, asdu.num
                );
                match asdu.type_id {
                    TYPE_C_IC_NA_1 => {
                        // ACT_CON -> data (interrogated) -> ACT_TERM
                        let mut ac = Asdu::new(
                            TYPE_C_IC_NA_1,
                            COT_ACT_CON,
                            false,
                            self.ca,
                            1,
                            asdu.info.clone(),
                        );
                        ac.num = 1;
                        let f = encode_i(self.send_seq, self.recv_seq, &ac);
                        self.send_seq = self.send_seq.wrapping_add(1);
                        self.send(stream, &f, "I/IC_ACT_CON");
                        self.push_all(stream, COT_INTERROGATED);
                        let mut at = Asdu::new(
                            TYPE_C_IC_NA_1,
                            COT_ACT_TERM,
                            false,
                            self.ca,
                            1,
                            asdu.info.clone(),
                        );
                        at.num = 1;
                        let f = encode_i(self.send_seq, self.recv_seq, &at);
                        self.send_seq = self.send_seq.wrapping_add(1);
                        self.send(stream, &f, "I/IC_ACT_TERM");
                    }
                    TYPE_C_CS_NA_1 => {
                        let mut ac = Asdu::new(
                            TYPE_C_CS_NA_1,
                            COT_ACT_CON,
                            false,
                            self.ca,
                            1,
                            asdu.info.clone(),
                        );
                        ac.num = 1;
                        let f = encode_i(self.send_seq, self.recv_seq, &ac);
                        self.send_seq = self.send_seq.wrapping_add(1);
                        self.send(stream, &f, "I/CS_ACT_CON");
                        let mut at = Asdu::new(
                            TYPE_C_CS_NA_1,
                            COT_ACT_TERM,
                            false,
                            self.ca,
                            1,
                            asdu.info.clone(),
                        );
                        at.num = 1;
                        let f = encode_i(self.send_seq, self.recv_seq, &at);
                        self.send_seq = self.send_seq.wrapping_add(1);
                        self.send(stream, &f, "I/CS_ACT_TERM");
                    }
                    TYPE_C_SC_NA_1 => {
                        if let Some(ioa) = asdu.first_ioa() {
                            let on = asdu.info.get(3).map(|b| b & 0x01 != 0).unwrap_or(false);
                            if let Some(p) = self.points.iter_mut().find(|p| p.ioa as u32 == ioa) {
                                p.value = if on { 1.0 } else { 0.0 };
                                println!("CMD C_SC {} -> {}", ioa, on);
                            }
                            let info = vec![
                                ioa as u8,
                                (ioa >> 8) as u8,
                                (ioa >> 16) as u8,
                                if on { 0x81 } else { 0x80 },
                            ];
                            let ac =
                                Asdu::new(TYPE_C_SC_NA_1, COT_ACT_CON, false, self.ca, 1, info);
                            let f = encode_i(self.send_seq, self.recv_seq, &ac);
                            self.send_seq = self.send_seq.wrapping_add(1);
                            self.send(stream, &f, "I/SC_ACT_CON");
                        }
                    }
                    TYPE_C_SE_NC_1 => {
                        if let Some(ioa) = asdu.first_ioa() {
                            let raw = asdu
                                .info
                                .get(3..7)
                                .map(|b| f32::from_be_bytes([b[0], b[1], b[2], b[3]]))
                                .unwrap_or(0.0);
                            if let Some(p) = self.points.iter_mut().find(|p| p.ioa as u32 == ioa) {
                                p.value = raw as f64;
                                println!("CMD C_SE {} -> {}", ioa, raw);
                            }
                            let mut info = Vec::with_capacity(8);
                            info.extend_from_slice(&[
                                ioa as u8,
                                (ioa >> 8) as u8,
                                (ioa >> 16) as u8,
                            ]);
                            info.extend_from_slice(&raw.to_be_bytes());
                            info.push(0x00);
                            let ac =
                                Asdu::new(TYPE_C_SE_NC_1, COT_ACT_CON, false, self.ca, 1, info);
                            let f = encode_i(self.send_seq, self.recv_seq, &ac);
                            self.send_seq = self.send_seq.wrapping_add(1);
                            self.send(stream, &f, "I/SE_ACT_CON");
                        }
                    }
                    _ => {}
                }
                // Ack the I-frame (one S-frame per batch, handled by caller).
            }
        }
    }
}

fn handle_client(mut stream: TcpStream) {
    println!("client connected");
    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
    let mut slave = Slave::new();
    let mut rx = Vec::new();
    let started = Instant::now();
    loop {
        let mut chunk = [0u8; 4096];
        let n = match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => 0,
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => 0,
            Err(e) => {
                eprintln!("read error: {}", e);
                break;
            }
        };
        if n > 0 {
            rx.extend_from_slice(&chunk[..n]);
            let mut consumed = 0usize;
            while consumed + 2 <= rx.len() {
                let len = rx[consumed + 1] as usize;
                if len < 4 || len > 255 || consumed + 2 + len > rx.len() {
                    break;
                }
                let frame: Vec<u8> = rx[consumed..consumed + 2 + len].to_vec();
                consumed += 2 + len;
                slave.handle(&mut stream, &frame);
            }
            rx.drain(..consumed);
        }
        if slave.started && slave.recv_seq > 0 {
            // S-frame ack for received I-frames (once per loop).
            let sf = encode_s(slave.recv_seq);
            slave.send(&mut stream, &sf, "S/ack");
            slave.recv_seq = 0;
        }
        // Spontaneous push once per second.
        let elapsed = started.elapsed().as_secs_f64();
        if slave.started && slave.last_push.elapsed() >= Duration::from_secs(1) {
            slave.last_push = Instant::now();
            slave.update_sim(elapsed);
            slave.push_all(&mut stream, COT_SPONTANEOUS);
        }
    }
    println!("client disconnected");
}

fn main() {
    println!("IEC104 slave listening on 127.0.0.1:{}", PORT);
    let listener = TcpListener::bind(("127.0.0.1", PORT)).expect("bind 2404");
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                if let Some(local) = stream.local_addr().ok() {
                    let _ = local;
                }
                handle_client(stream);
            }
            Err(e) => eprintln!("accept error: {}", e),
        }
    }
}
