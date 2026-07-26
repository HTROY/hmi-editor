//! Bridge Layer
//!
//! Connects the plugin point stream to the WebSocket broadcast.
//! Receives PointValues from plugins, filters them via PointManager,
//! and publishes changed values to all connected WebSocket clients.

use crate::point::manager::PointManager;
use crate::point::types::{PointValue, WsDataMessage};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};

pub struct Bridge {
    point_rx: mpsc::UnboundedReceiver<PointValue>,
    point_manager: Arc<Mutex<PointManager>>,
    broadcast_tx: broadcast::Sender<String>,
    batch_interval_ms: u64,
}

impl Bridge {
    pub fn new(
        point_rx: mpsc::UnboundedReceiver<PointValue>,
        point_manager: Arc<Mutex<PointManager>>,
        batch_interval_ms: u64,
    ) -> (Self, broadcast::Sender<String>) {
        let (broadcast_tx, _) = broadcast::channel::<String>(256);
        let bridge = Self {
            point_rx,
            point_manager,
            broadcast_tx: broadcast_tx.clone(),
            batch_interval_ms,
        };
        (bridge, broadcast_tx)
    }

    pub async fn run(mut self) {
        log::info!(
            "Bridge started, managing {} points (batch every {}ms)",
            self.point_manager.lock().unwrap().count(),
            self.batch_interval_ms
        );
        let mut batch: Vec<PointValue> = Vec::new();
        let mut batch_timer =
            tokio::time::interval(tokio::time::Duration::from_millis(self.batch_interval_ms));

        loop {
            tokio::select! {
                Some(raw_point) = self.point_rx.recv() => {
                    if let Some(pv) = self.point_manager.lock().unwrap().update(raw_point) {
                        batch.push(pv);
                    }
                }
                _ = batch_timer.tick() => {
                    if !batch.is_empty() {
                        let msg = WsDataMessage::new(std::mem::take(&mut batch));
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = self.broadcast_tx.send(json);
                        }
                    }
                }
                else => {
                    if !batch.is_empty() {
                        let msg = WsDataMessage::new(std::mem::take(&mut batch));
                        if let Ok(json) = serde_json::to_string(&msg) {
                            let _ = self.broadcast_tx.send(json);
                        }
                    }
                    break;
                }
            }
        }
        log::info!("Bridge stopped");
    }
}
