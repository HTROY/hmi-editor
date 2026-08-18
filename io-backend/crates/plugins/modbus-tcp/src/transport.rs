//! Modbus TCP transport（F18 ③：从 lib.rs 拆分）。
//!
//! 最小 MBAP 客户端（不依赖 `modbus` crate），每个 TX/RX 帧都上报宿主
//! 供报文日志使用。`Mbap` 所有权在 scan/write 期间由调用方持有，
//! 不跨 `await` 持锁。

use crate::codec::{build_request_frame, hex_str, parse_response, split_addr, MBAP_HEADER_LEN};
use crate::hmi::plugin::events;
use plugin_kit::PointCfg;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

/// Minimal Modbus TCP client over a raw TcpStream. Exists (instead of the
/// `modbus` crate) so every TX/RX frame can be captured and reported to the
/// host for the packet log.
pub struct Mbap {
    stream: TcpStream,
    tid: u16,
    uid: u8,
}

impl Mbap {
    pub fn connect(
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

    pub fn close(&mut self) -> std::io::Result<()> {
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

    pub(crate) async fn write_single(
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

    pub(crate) async fn write_multiple_registers(
        &mut self,
        addr: u16,
        vals: &[u16],
    ) -> Result<(), String> {
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

/// 读一个点位（coil/discrete_input/holding/input register）。
pub async fn mb_read(stream: &mut Mbap, pt: &PointCfg) -> Result<f64, String> {
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
            let count = if crate::codec::is_32bit(&pt.data_type) {
                2
            } else {
                1
            };
            let regs = stream.read_registers(fc, fc_name, addr, count).await?;
            if regs.len() < count as usize {
                return Err("short response".to_string());
            }
            Ok(crate::codec::decode_point(pt, &regs))
        }
        _ => Err(format!("unknown addr type: {}", pt.address)),
    }
}
