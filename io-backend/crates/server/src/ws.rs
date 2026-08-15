//! WebSocket Server
//!
//! Provides a tokio-tungstenite WebSocket server that:
//! - Broadcasts point value updates to connected clients
//! - Sends initial snapshot on connection
//! - Supports per-client variable subscription filtering
//! - Receives control commands from clients and routes to plugins

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, RwLock};
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use hmi_io_alarm::engine::AlarmEngine;
use hmi_io_alarm::persist::{alarm_rules_json, alarm_snapshot_json};
use hmi_io_config::ServerConfig;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
use hmi_io_point::types::{PointValue, WsDataMessage};

/// Inbound client command — the flat JSON protocol the frontend
/// `WebSocketClient` sends: `{ "command": "control", "variableId": ..., "value": ... }`,
/// `{ "command": "subscribe", "variableIds": [...] }` or `{ "command": "heartbeat" }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "lowercase")]
enum ClientCommand {
    Control {
        #[serde(rename = "variableId")]
        variable_id: String,
        value: ControlValue,
    },
    Subscribe {
        #[serde(rename = "variableIds", default)]
        variable_ids: Vec<String>,
    },
    Heartbeat,
}

/// A control value may be numeric or boolean (AO/DO writes).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(untagged)]
enum ControlValue {
    Number(f64),
    Boolean(bool),
}

impl ControlValue {
    /// Normalize to the f64 form the plugin registry accepts: booleans
    /// become 1.0 / 0.0 instead of being silently dropped.
    fn as_f64(self) -> f64 {
        match self {
            ControlValue::Number(n) => n,
            ControlValue::Boolean(b) => {
                if b {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

/// Keep only the points the client subscribed to. An empty subscription set
/// means "receive everything" and is handled by the caller without calling
/// this function.
fn filter_points(data: Vec<PointValue>, subscribed: &HashSet<String>) -> Vec<PointValue> {
    data.into_iter()
        .filter(|pv| subscribed.contains(&pv.id))
        .collect()
}

pub async fn run_server(
    config: &ServerConfig,
    broadcast_tx: broadcast::Sender<String>,
    registry: Arc<PluginRegistry>,
    point_manager: Arc<Mutex<PointManager>>,
    monitor: Arc<MonitorCollector>,
    alarm_engine: Option<Arc<AlarmEngine>>,
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
        // 冗余模式下 Standby 节点拒绝 WS 服务（HMI 前端会尝试下一个地址）
        if !point_manager.lock().unwrap().is_active() {
            log::info!("Rejecting WS connection from {}: node is standby", peer);
            continue;
        }
        let bc_rx = broadcast_tx.subscribe();
        let reg = registry.clone();
        let pm = point_manager.clone();
        let mon = monitor.clone();
        let alarm = alarm_engine.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, bc_rx, reg, pm, mon, alarm).await {
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
    alarm_engine: Option<Arc<AlarmEngine>>,
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

    // Alarm snapshot + rules for the new client
    if let Some(eng) = &alarm_engine {
        let active = eng.active_occurrences();
        let rules = eng.rules();
        let mut msgs = vec![alarm_snapshot_json(&active), alarm_rules_json(&rules)];
        // Send rules first so the frontend has definitions before occurrences.
        msgs.reverse();
        for json in msgs {
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    }

    // Per-connection subscription filter (empty = receive all)
    let subscribed_ids: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));
    let sub_ids = subscribed_ids.clone();

    let send_h = tokio::spawn(async move {
        loop {
            match bc_rx.recv().await {
                Ok(msg) => {
                    // Parse the broadcast payload once; every producer sends a
                    // JSON envelope with a "type" field.
                    let parsed: serde_json::Value = match serde_json::from_str(&msg) {
                        Ok(v) => v,
                        Err(_) => {
                            log::debug!("Skipping non-JSON broadcast message");
                            continue;
                        }
                    };
                    let msg_type = parsed
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or_default();
                    // 降级消息：本机转为 Standby，立即断开所有 WS 客户端
                    if msg_type == "role"
                        && parsed.get("state").and_then(|s| s.as_str()) == Some("standby")
                    {
                        log::info!("Node demoted to standby, closing WS client");
                        break;
                    }
                    if msg_type == "data" {
                        // Data messages respect the per-client filter. The
                        // read guard lives only inside this block, so it is
                        // released before any await below.
                        let (forward_all, points): (bool, Vec<PointValue>) = {
                            let sub = sub_ids.read().unwrap();
                            if sub.is_empty() {
                                (true, Vec::new())
                            } else {
                                match serde_json::from_value::<WsDataMessage>(parsed) {
                                    Ok(wm) => (false, filter_points(wm.data, &sub)),
                                    Err(_) => (false, Vec::new()),
                                }
                            }
                        };
                        if forward_all {
                            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        } else if !points.is_empty() {
                            let fmsg = WsDataMessage {
                                msg_type: "data".into(),
                                data: points,
                            };
                            if let Ok(json) = serde_json::to_string(&fmsg) {
                                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    } else if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                        // Non-data messages (config_change, alarms, ...) pass through
                        break;
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
    subscribed_ids: &Arc<RwLock<HashSet<String>>>,
) -> anyhow::Result<()> {
    let msg: ClientCommand = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            log::debug!("Ignoring unknown client message: {}", e);
            return Ok(());
        }
    };
    match msg {
        ClientCommand::Control { variable_id, value } => {
            let val = value.as_f64();
            log::info!("Control: {} = {}", variable_id, val);
            if let Err(e) = registry.write_point(&variable_id, val).await {
                log::error!("Control write error: {}", e);
            }
        }
        ClientCommand::Subscribe { variable_ids } => {
            // Update per-connection subscription filter
            let mut sub = subscribed_ids.write().unwrap();
            sub.clear();
            if variable_ids.is_empty() {
                log::info!("Client unsubscribed filter - receiving all points");
            } else {
                sub.extend(variable_ids);
                log::info!("Client subscribed to {} variables", sub.len());
            }
        }
        ClientCommand::Heartbeat => { /* no-op */ }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<ClientCommand, serde_json::Error> {
        serde_json::from_str(text)
    }

    #[test]
    fn parses_flat_control_message_with_numeric_value() {
        // Frontend WebSocketClient sends the flat shape, not a nested value.
        let msg = parse(r#"{"command":"control","variableId":"modbus_1:STA1_TEMP","value":12.5}"#)
            .unwrap();
        match msg {
            ClientCommand::Control { variable_id, value } => {
                assert_eq!(variable_id, "modbus_1:STA1_TEMP");
                assert_eq!(value.as_f64(), 12.5);
            }
            other => panic!("expected control, got {:?}", other),
        }
    }

    #[test]
    fn parses_boolean_control_value() {
        let msg = parse(r#"{"command":"control","variableId":"pump:DO1","value":true}"#).unwrap();
        match msg {
            ClientCommand::Control { value, .. } => assert_eq!(value.as_f64(), 1.0),
            other => panic!("expected control, got {:?}", other),
        }
        let msg = parse(r#"{"command":"control","variableId":"pump:DO1","value":false}"#).unwrap();
        match msg {
            ClientCommand::Control { value, .. } => assert_eq!(value.as_f64(), 0.0),
            other => panic!("expected control, got {:?}", other),
        }
    }

    #[test]
    fn control_without_value_is_rejected() {
        // A missing value must not silently become 0.0.
        assert!(parse(r#"{"command":"control","variableId":"a:b"}"#).is_err());
    }

    #[test]
    fn parses_subscribe_with_variable_ids() {
        let msg = parse(r#"{"command":"subscribe","variableIds":["a","b","c"]}"#).unwrap();
        match msg {
            ClientCommand::Subscribe { variable_ids } => {
                assert_eq!(variable_ids, vec!["a", "b", "c"])
            }
            other => panic!("expected subscribe, got {:?}", other),
        }
    }

    #[test]
    fn subscribe_without_variable_ids_defaults_to_empty() {
        let msg = parse(r#"{"command":"subscribe"}"#).unwrap();
        match msg {
            ClientCommand::Subscribe { variable_ids } => assert!(variable_ids.is_empty()),
            other => panic!("expected subscribe, got {:?}", other),
        }
    }

    #[test]
    fn parses_heartbeat() {
        assert!(matches!(
            parse(r#"{"command":"heartbeat"}"#).unwrap(),
            ClientCommand::Heartbeat
        ));
    }

    #[test]
    fn rejects_unknown_command() {
        assert!(parse(r#"{"command":"explode"}"#).is_err());
    }

    #[test]
    fn rejects_nested_envelope_that_backend_never_understood() {
        // The old frontend envelope `{command, value:{variableId,value}}`
        // must be rejected instead of writing 0.0 to an empty variable id.
        assert!(parse(r#"{"command":"control","value":{"variableId":"x","value":1}}"#).is_err());
    }

    #[test]
    fn filter_points_keeps_only_subscribed_ids() {
        let data = vec![
            PointValue::new("a", 1.0, "good", 1),
            PointValue::new("b", 2.0, "good", 2),
            PointValue::new("c", 3.0, "good", 3),
        ];
        let sub: HashSet<String> = ["a", "c"].iter().map(|s| s.to_string()).collect();
        let out = filter_points(data, &sub);
        let ids: Vec<&str> = out.iter().map(|pv| pv.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
    }

    #[test]
    fn filter_points_with_no_match_or_empty_set_returns_empty() {
        let data = vec![PointValue::new("a", 1.0, "good", 1)];
        let sub: HashSet<String> = ["zzz"].iter().map(|s| s.to_string()).collect();
        assert!(filter_points(data.clone(), &sub).is_empty());
        assert!(filter_points(data, &HashSet::new()).is_empty());
    }
}
