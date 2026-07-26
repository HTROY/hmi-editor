//! WebSocket Server
//!
//! Provides a tokio-tungstenite WebSocket server that:
//! - Broadcasts point value updates to connected clients
//! - Sends initial snapshot on connection
//! - Supports per-client variable subscription filtering
//! - Receives control commands from clients and routes to plugins

use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::config::ServerConfig;
use crate::monitor::collector::MonitorCollector;
use crate::plugin::registry::PluginRegistry;
use crate::point::manager::PointManager;
use crate::point::types::{PointValue, WsDataMessage};

pub async fn run_server(
    config: &ServerConfig,
    broadcast_tx: broadcast::Sender<String>,
    registry: Arc<PluginRegistry>,
    point_manager: Arc<Mutex<PointManager>>,
    monitor: Arc<MonitorCollector>,
) -> anyhow::Result<()> {
    let addr: std::net::SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    let listener = socket.listen(1024)?;
    log::info!("WebSocket server listening on ws://{}", addr);

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                log::error!("Accept error: {}", e);
                continue;
            }
        };
        log::info!("New connection from {}", peer);
        let bc_rx = broadcast_tx.subscribe();
        let reg = registry.clone();
        let pm = point_manager.clone();
        let mon = monitor.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, bc_rx, reg, pm, mon).await {
                log::error!("Conn error ({}): {}", peer, e);
            }
            log::info!("Conn closed: {}", peer);
        });
    }
}

async fn handle_connection(
    stream: TcpStream,
    broadcast_rx: broadcast::Receiver<String>,
    registry: Arc<PluginRegistry>,
    point_manager: Arc<Mutex<PointManager>>,
    monitor: Arc<MonitorCollector>,
) -> anyhow::Result<()> {
    let ws = accept_async(stream).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut bc_rx = broadcast_rx;

    // Track connected client
    monitor.ws_client_connected();

    // Send initial snapshot of all known point values
    // Lock held only in this block, dropped before the await below
    let snapshot_json: Option<String> = {
        let pm = point_manager.lock().unwrap();
        let values = pm.get_all_values();
        if !values.is_empty() {
            let msg = WsDataMessage {
                msg_type: "snapshot".into(),
                data: values,
            };
            serde_json::to_string(&msg).ok()
        } else {
            None
        }
    };
    if let Some(json) = snapshot_json {
        let _ = ws_tx.send(Message::Text(json.into())).await;
        log::info!("Sent snapshot");
    }

    // Per-connection subscription filter (empty = receive all)
    let subscribed_ids: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let sub_ids = subscribed_ids.clone();

    let send_h = tokio::spawn(async move {
        loop {
            match bc_rx.recv().await {
                Ok(msg) => {
                    // Quick check: is this a data message that needs filtering?
                    let is_data_msg =
                        msg.contains("\"type\":\"data\"") || msg.contains("\"type\": \"data\"");
                    let should_filter: Option<Vec<String>> = if is_data_msg {
                        let sub = sub_ids.lock().unwrap();
                        if sub.is_empty() {
                            None
                        } else {
                            Some(sub.iter().cloned().collect())
                        }
                    } else {
                        None // Non-data messages (config_change, etc.) always pass through
                    };

                    if let Some(filter_ids) = should_filter {
                        if let Ok(parsed) = serde_json::from_str::<WsDataMessage>(&msg) {
                            let filtered: Vec<PointValue> = parsed
                                .data
                                .into_iter()
                                .filter(|pv| filter_ids.contains(&pv.id))
                                .collect();
                            if !filtered.is_empty() {
                                let fmsg = WsDataMessage {
                                    msg_type: parsed.msg_type.clone(),
                                    data: filtered,
                                };
                                if let Ok(json) = serde_json::to_string(&fmsg) {
                                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    } else {
                        // No filter - forward everything
                        if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("Client lagged by {}", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let recv_h = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Text(t) => {
                    if let Err(e) = handle_client_message(&t, &registry, &subscribed_ids).await {
                        log::warn!("Msg error: {}", e);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! { _ = send_h => {}, _ = recv_h => {} }

    // Track disconnected client
    monitor.ws_client_disconnected();
    Ok(())
}

async fn handle_client_message(
    text: &str,
    registry: &Arc<PluginRegistry>,
    subscribed_ids: &Arc<Mutex<HashSet<String>>>,
) -> anyhow::Result<()> {
    let msg: serde_json::Value = serde_json::from_str(text)?;
    match msg.get("command").and_then(|v| v.as_str()) {
        Some("control") => {
            let var = msg.get("variableId").and_then(|v| v.as_str()).unwrap_or("");
            let val = msg.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0);
            log::info!("Control: {} = {}", var, val);
            if let Err(e) = registry.write_point(var, val).await {
                log::error!("Control write error: {}", e);
            }
        }
        Some("subscribe") => {
            // Update per-connection subscription filter
            let variable_ids: Vec<String> = msg
                .get("variableIds")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let mut sub = subscribed_ids.lock().unwrap();
            sub.clear();
            if variable_ids.is_empty() {
                log::info!("Client unsubscribed filter - receiving all points");
            } else {
                for id in &variable_ids {
                    sub.insert(id.clone());
                }
                log::info!("Client subscribed to {} variables", variable_ids.len());
            }
        }
        Some("heartbeat") => { /* no-op */ }
        o => log::debug!("Unknown cmd: {:?}", o),
    }
    Ok(())
}
