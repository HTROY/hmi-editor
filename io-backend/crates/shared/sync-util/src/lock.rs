//! Mutex/RwLock 中毒恢复。
//!
//! `std::sync` 的锁在持锁线程 panic 后进入中毒状态，后续
//! `lock().unwrap()` 会再次 panic，把单点故障扩散为整服务故障。
//! 这里提供恢复式取锁：中毒时记录错误并 `into_inner` 恢复内部状态，
//! 让服务继续运行（持有数据可能处于不一致状态，由调用方语义兜底，
//! 例如插件连接状态由重连流程重建）。

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// 取 `Mutex` 锁；中毒时记录错误并恢复内部值。
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| {
        log::error!("Mutex poisoned; recovering with into_inner");
        poisoned.into_inner()
    })
}

/// 取 `RwLock` 读锁；中毒时记录错误并恢复内部值。
pub fn read<T>(r: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    r.read().unwrap_or_else(|poisoned| {
        log::error!("RwLock read poisoned; recovering with into_inner");
        poisoned.into_inner()
    })
}

/// 取 `RwLock` 写锁；中毒时记录错误并恢复内部值。
pub fn write<T>(r: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    r.write().unwrap_or_else(|poisoned| {
        log::error!("RwLock write poisoned; recovering with into_inner");
        poisoned.into_inner()
    })
}

/// 取 `Mutex` 锁；中毒时恢复并记录错误。等价于 [`lock`]，提供方法链便利。
pub trait MutexExt<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        lock(self)
    }
}

/// 取 `RwLock` 读/写锁；中毒时恢复并记录错误。等价于 [`read`]/[`write`]。
pub trait RwLockExt<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T>;
    fn write_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockExt<T> for RwLock<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T> {
        read(self)
    }

    fn write_recover(&self) -> RwLockWriteGuard<'_, T> {
        write(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutex_recovers_from_poison() {
        let m: Mutex<i32> = Mutex::new(1);
        // 持锁 panic → 中毒
        let _ = std::panic::catch_unwind(|| {
            let _g = m.lock().unwrap();
            panic!("boom");
        });
        // 恢复取锁：拿到内部值，不 panic
        assert_eq!(*lock(&m), 1);
    }

    #[test]
    fn rwlock_recovers_from_poison() {
        let r: RwLock<i32> = RwLock::new(2);
        let _ = std::panic::catch_unwind(|| {
            let _g = r.write().unwrap();
            panic!("boom");
        });
        assert_eq!(*read(&r), 2);
        assert_eq!(*write(&r), 2);
    }

    #[test]
    fn ext_traits_recover() {
        let m: Mutex<i32> = Mutex::new(3);
        let _ = std::panic::catch_unwind(|| {
            let _g = m.lock().unwrap();
            panic!("boom");
        });
        assert_eq!(*m.lock_recover(), 3);

        let r: RwLock<i32> = RwLock::new(4);
        let _ = std::panic::catch_unwind(|| {
            let _g = r.write().unwrap();
            panic!("boom");
        });
        assert_eq!(*r.read_recover(), 4);
        assert_eq!(*r.write_recover(), 4);
    }
}
