//! tokio 任务 spawn 监控。
//!
//! `tokio::spawn` 返回的 `JoinHandle` 若被丢弃，任务 panic 只会被 tokio
//! 打印到 stderr 而不会进入应用日志；此处提供带 panic 边界的封装：
//! 任务 panic 时记录 error 日志，避免静默消失。

use std::future::Future;

/// 带 panic 边界的 spawn：任务 panic 时记录错误日志。
///
/// 返回的 `JoinHandle` 包装了原任务，`await` 它总能拿到 `Ok`，
/// panic 已被捕获并记录。
pub fn spawn_monitored<F, T>(name: &str, fut: F) -> tokio::task::JoinHandle<Option<T>>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let name = name.to_string();
    tokio::spawn(async move {
        let handle = tokio::task::spawn(fut);
        match handle.await {
            Ok(out) => Some(out),
            Err(e) if e.is_panic() => {
                log::error!("Task '{}' panicked: {}", name, e);
                None
            }
            Err(e) => {
                log::error!("Task '{}' failed/cancelled: {}", name, e);
                None
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn panic_is_captured_not_silent() {
        let h = spawn_monitored("panic-task", async {
            panic!("intentional panic");
        });
        let res = h.await.unwrap();
        assert!(res.is_none());
    }

    #[tokio::test]
    async fn success_passes_value_through() {
        let h = spawn_monitored("ok-task", async { 42 });
        assert_eq!(h.await.unwrap(), Some(42));
    }

    #[tokio::test]
    async fn sleep_completes() {
        let h = spawn_monitored("sleep-task", async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            "done"
        });
        assert_eq!(h.await.unwrap(), Some("done"));
    }
}
