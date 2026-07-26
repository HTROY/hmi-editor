//! WebSocket Server
//!
//! Provides a tokio-tungstenite WebSocket server that:
//! - Broadcasts point value updates to connected clients
//! - Receives control commands from clients and routes to plugins

use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use futures_util::{StreamExt, SinkExt};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::plugin::registry::PluginRegistry;
use crate::config::ServerConfig;

pub async fn run_server(
    config: &ServerConfig,
    broadcast_tx: broadcast::Sender<String>,
    registry: Arc<PluginRegistry>,
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
            Err(e) => { log::error!("Accept error: {}", e); continue; }
        };
        log::info!("New connection from {}", peer);
        let bc_rx = broadcast_tx.subscribe();
        let reg = registry.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, bc_rx, reg).await {
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
) -> anyhow::Result<()> {
    let ws = accept_async(stream).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut bc_rx = broadcast_rx;

    let send_h = tokio::spawn(async move {
        loop {
            match bc_rx.recv().await {
                Ok(msg) => { if ws_tx.send(Message::Text(msg.into())).await.is_err() { break; } }
                Err(broadcast::error::RecvError::Lagged(n)) => { log::warn!("Client lagged by {}", n); }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let recv_h = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Text(t) => {
                    if let Err(e) = handle_client_message(&t, &registry).await {
                        log::warn!("Msg error: {}", e);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! { _ = send_h => {}, _ = recv_h => {} }
    Ok(())
}

async fn handle_client_message(text: &str, registry: &Arc<PluginRegistry>) -> anyhow::Result<()> {
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
        Some("subscribe") | Some("heartbeat") => { /* no-op */ }
        o => log::debug!("Unknown cmd: {:?}", o),
    }
    Ok(())
}

