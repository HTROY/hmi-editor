//! Modbus TCP Protocol Plugin (wasip2 component)
//!
//! 结构（F18）：
//! - `codec.rs`    — MBAP 帧编解码 / 值编解码（与 iec104-core、ua-core 对齐）
//! - `transport.rs`— Mbap 最小客户端 + 点位读写
//! - `state.rs`    — 配置与运行状态（实现 plugin_kit::KitState）
//! - 本文件        — 宿主生命周期（Guest）骨架，锁只在短临界区内持有，
//!                   不跨 `await` 持锁（plugin_kit::Kit 的 take/put 流模式）
wit_bindgen::generate!({
    world: "hmi-plugin",
    path: "../../../wit",
});

mod codec;
mod state;
mod transport;

use crate::exports::hmi::plugin::lifecycle::Guest;
use crate::state::{PluginConfig, PluginState};
use hmi::plugin::events;
use plugin_kit::events::PluginEvents;
use plugin_kit::{now_ms, report_failure, Kit};
use std::time::Duration;
use transport::Mbap;

static KIT: Kit<PluginState, Mbap> = Kit::new();

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

struct Plugin;

impl Guest for Plugin {
    async fn init(config_json: String) -> u32 {
        let c: PluginConfig = match serde_json::from_str(&config_json) {
            Ok(c) => c,
            Err(e) => {
                events::log(1, format!("modbus init err: {}", e)).await;
                return 1;
            }
        };
        events::log(
            2,
            format!(
                "Modbus TCP init: {}:{}, slave={}, {} pts",
                c.host,
                c.port,
                c.slave_id,
                c.points.len()
            ),
        )
        .await;
        KIT.commit(PluginState {
            host: c.host,
            port: c.port,
            slave_id: c.slave_id,
            connected: false,
            scan_count: 0,
            points: c.points,
        });
        0
    }

    async fn connect() -> u32 {
        let s = match KIT.state().as_ref() {
            Some(s) => s.clone(),
            None => return 1,
        };
        // Re-entrant: close any stale socket before opening a new connection.
        if let Some(mut old) = KIT.take_stream() {
            let _ = old.close();
        }
        events::log(2, format!("Modbus TCP connecting {}:{}...", s.host, s.port)).await;
        match Mbap::connect(
            &s.host,
            s.port,
            Duration::from_secs(5),
            Duration::from_millis(2000),
            Duration::from_millis(2000),
            s.slave_id,
        ) {
            Ok(t) => {
                KIT.put_stream(t);
                KIT.mark_connected(true);
                events::log(2, "connected".to_string()).await;
                0
            }
            Err(e) => {
                KIT.mark_connected(false);
                events::log(1, format!("connect failed: {}", e)).await;
                1
            }
        }
    }

    async fn disconnect() -> u32 {
        if let Some(mut t) = KIT.take_stream() {
            let _ = t.close();
        }
        KIT.mark_connected(false);
        0
    }

    async fn scan_points() -> u32 {
        let s = match KIT.begin_scan() {
            Some(s) => s,
            None => return 1,
        };
        let now = now_ms();
        // 流从锁中取出：scan 循环内（含跨 await 的 on_point）不持任何锁。
        let mut stream = match KIT.take_stream() {
            Some(stream) => stream,
            None => return 1,
        };
        let mut had_error = false;
        for pt in &s.points {
            match transport::mb_read(&mut stream, pt).await {
                Ok(v) => {
                    events::on_point(pt.variable_id.clone(), v, "good".to_string(), now).await;
                }
                Err(e) => {
                    had_error = true;
                    report_failure(&Events, &pt.variable_id, &e, now).await;
                }
            }
        }
        if had_error {
            KIT.link_lost();
            return 1;
        }
        KIT.put_stream(stream);
        0
    }

    async fn write_point(name: String, value: f64) -> u32 {
        let s = match KIT.state().as_ref() {
            Some(s) => s.clone(),
            None => return 1,
        };
        if !s.connected {
            return 2;
        }
        let pt = match s.points.iter().find(|p| p.variable_id == name).cloned() {
            Some(pt) => pt,
            None => return 3,
        };
        let mut stream = match KIT.take_stream() {
            Some(stream) => stream,
            None => return 2,
        };
        let result = if let Some(rest) = pt.address.strip_prefix("coil:") {
            let addr = match rest.parse::<u16>() {
                Ok(a) => a,
                Err(_) => return 3,
            };
            let on = value != 0.0;
            stream
                .write_single(5, "WR_COIL", addr, if on { 0xff00 } else { 0x0000 })
                .await
        } else if let Some(rest) = pt.address.strip_prefix("holding_register:") {
            let addr = match rest.parse::<u16>() {
                Ok(a) => a,
                Err(_) => return 3,
            };
            let vals = codec::encode_value(&pt.data_type, &pt.byte_order, value);
            if vals.len() == 1 {
                stream.write_single(6, "WR_HREG", addr, vals[0]).await
            } else {
                stream.write_multiple_registers(addr, &vals).await
            }
        } else {
            return 3;
        };
        match result {
            Ok(_) => {
                events::log(2, format!("write {}={} done", name, value)).await;
                KIT.put_stream(stream);
                0
            }
            Err(e) => {
                events::log(1, format!("write {} failed: {}", name, e)).await;
                KIT.link_lost();
                4
            }
        }
    }

    async fn get_name() -> String {
        "Modbus TCP".to_string()
    }

    async fn get_status() -> u32 {
        KIT.status()
    }
}

export!(Plugin);
