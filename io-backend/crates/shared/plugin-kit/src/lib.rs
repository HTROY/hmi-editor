//! WASM 插件共享骨架（F18）。
//!
//! 三个协议 guest（modbus-tcp / opc-ua / iec104）过去各自维护
//! `static STATE: Mutex<Option<...>>` + `static STREAM: Mutex<Option<...>>`、
//! `now_ms()`、`hex()`、`get_status` 与 scan 计数样板，且在 scan 循环中
//! 跨 `await` 持有 `std::sync::Mutex`（单线程 wasm guest 下与其他导出
//! 并发取锁会死锁）。
//!
//! 本 crate 提供：
//! - [`PointCfg`]：三插件一致的点表配置结构；
//! - [`Kit`]：状态/流容器，`take_stream`/`put_stream` 保证协议 IO 期间
//!   不持锁，`begin_scan`/`mark_connected`/`link_lost`/`status` 收敛
//!   生命周期样板；
//! - [`KitState`]：guest 协议状态需实现的访问 trait；
//! - [`PluginEvents`] + [`report_failure`]：on_point 错误策略统一。
//!
//! 各协议只保留自己的 connect 握手、read/write 与编解码逻辑。

pub mod events;
pub mod kit;
pub mod point;

pub use events::{report_failure, PluginEvents};
pub use kit::{Kit, KitState};
pub use point::PointCfg;

use std::time::{SystemTime, UNIX_EPOCH};

/// 当前毫秒时间戳。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 字节流十六进制（大写，空格分隔）。
pub fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<String>>()
        .join(" ")
}
