//! 连接状态机 / 生命周期骨架（F18 ①）。
//!
//! [`Kit`] 取代各 guest 的 `static STATE/STREAM` 样板：
//! - 状态与流分别放在两个 `Mutex<Option<_>>` 中，取锁只做短暂访问；
//! - [`Kit::take_stream`] 把流从锁中取出，协议 IO（含跨 `await` 的
//!   `on_point`/`on_packet`）期间不持锁，IO 结束后 [`Kit::put_stream`]
//!   放回——消除跨 `await` 持有 `std::sync::Mutex` 的死锁风险（F18 ②）；
//! - 连接标志与 scan 计数收敛到 [`KitState`]：三插件统一走
//!   [`Kit::begin_scan`]（入口 + 计数）/ [`Kit::commit`]（写回）/
//!   [`Kit::mark_connected`] / [`Kit::link_lost`]，连接状态语义一致。

use std::sync::{Mutex, MutexGuard};
use sync_util::MutexExt;

/// Guest 协议状态需实现的访问 trait。
pub trait KitState {
    fn connected(&self) -> bool;
    fn set_connected(&mut self, connected: bool);
    fn bump_scan_count(&mut self);
}

/// 状态 + 流容器。
pub struct Kit<S, T> {
    state: Mutex<Option<S>>,
    stream: Mutex<Option<T>>,
}

impl<S, T> Kit<S, T> {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(None),
            stream: Mutex::new(None),
        }
    }

    /// 写入协议状态（init 与 scan/connect 后的写回都走这里）。
    pub fn commit(&self, state: S) {
        *self.state.lock_recover() = Some(state);
    }

    /// 短暂访问状态（不要在返回值存活期间跨 await）。
    pub fn state(&self) -> MutexGuard<'_, Option<S>> {
        self.state.lock_recover()
    }

    /// 取出流（锁随即释放）；IO 结束后用 [`Kit::put_stream`] 放回。
    pub fn take_stream(&self) -> Option<T> {
        self.stream.lock_recover().take()
    }

    /// 放回流。
    pub fn put_stream(&self, stream: T) {
        *self.stream.lock_recover() = Some(stream);
    }

    /// 丢弃当前流（断链时）。
    pub fn drop_stream(&self) {
        *self.stream.lock_recover() = None;
    }

    /// 短暂访问流（不要在返回值存活期间跨 await）。
    pub fn stream(&self) -> MutexGuard<'_, Option<T>> {
        self.stream.lock_recover()
    }
}

impl<S: KitState + Clone, T> Kit<S, T> {
    /// 连接状态 → 宿主可见状态码（2=connected，0=其它）。
    pub fn status(&self) -> u32 {
        match self.state().as_ref() {
            Some(s) if s.connected() => 2,
            _ => 0,
        }
    }

    /// 标记连接/断开。
    pub fn mark_connected(&self, connected: bool) {
        if let Some(s) = self.state().as_mut() {
            s.set_connected(connected);
        }
    }

    /// 一次 scan 的入口：未初始化或未连接返回 `None`；
    /// 否则递增 scan_count 并返回状态快照（克隆，不持锁）。
    pub fn begin_scan(&self) -> Option<S> {
        let mut guard = self.state();
        let s = guard.as_mut()?;
        if !s.connected() {
            return None;
        }
        s.bump_scan_count();
        Some(s.clone())
    }

    /// 断链收尾：标记断开并丢弃流。
    pub fn link_lost(&self) {
        self.mark_connected(false);
        self.drop_stream();
    }
}
