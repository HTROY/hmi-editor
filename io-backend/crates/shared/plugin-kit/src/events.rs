//! 宿主事件上报（on_point / log / on_packet）与错误策略。

/// guest 需要实现的事件上报：把宿主 import 的函数转发给
/// 本 guest `wit_bindgen::generate!` 生成的 `hmi::plugin::events`。
///
/// 用 RPITIT（返回 impl Future）显式声明 `Send`，避免 async fn in trait
/// 丢失 auto trait 约束（wasm guest 单线程下仍保持一致语义）。
pub trait PluginEvents {
    fn log<'a>(
        &'a self,
        level: u32,
        msg: String,
    ) -> impl std::future::Future<Output = ()> + Send + 'a;
    fn on_point<'a>(
        &'a self,
        name: String,
        value: f64,
        quality: String,
        ts: u64,
    ) -> impl std::future::Future<Output = ()> + Send + 'a;
    fn on_packet<'a>(
        &'a self,
        dir: String,
        proto: String,
        hex: String,
        summary: String,
    ) -> impl std::future::Future<Output = ()> + Send + 'a;
}

/// on_point 错误策略（三插件一致）：报 `0.0 / "bad"` 并记日志。
pub async fn report_failure<E: PluginEvents>(events: &E, name: &str, err: &str, ts: u64) {
    events
        .on_point(name.to_string(), 0.0, "bad".to_string(), ts)
        .await;
    events.log(1, err.to_string()).await;
}
