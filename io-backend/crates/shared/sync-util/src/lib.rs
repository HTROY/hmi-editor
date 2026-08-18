//! 共享同步工具：Mutex/RwLock 中毒恢复与任务 spawn 监控。
//!
//! 用途（见 refactoring-report F15）：
//! - [`lock`]：锁中毒时记录错误并通过 `into_inner` 恢复内部状态，避免
//!   `unwrap` 把单点故障扩散为整服务 panic。提供自由函数与扩展 trait
//!   （[`MutexExt`]/[`RwLockExt`]）两种用法。
//! - [`task`]（feature `task`）：tokio 任务带 panic 边界，任务 panic 时
//!   记录日志而不是静默消失（`JoinHandle` 被丢弃时 panic 不可见）。

pub mod lock;
#[cfg(feature = "task")]
pub mod task;

pub use lock::{lock, read, write, MutexExt, RwLockExt};
