//! Plugin actor loop plumbing.
//!
//! A [`PluginHandle`] is the registry-side handle to one running plugin
//! actor; [`PluginCommand`] carries write/status/shutdown requests over an
//! mpsc channel. [`run_plugin_actor`] is the actor loop that drives
//! `scan_points` on a fixed interval and reconnects on link loss.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use super::super::supervisor::should_reconnect;
use hmi_io_monitor::collector::MonitorCollector;

use super::super::interface::PluginInstance;

/// Minimum time between automatic reconnect attempts after a link loss.
const RECONNECT_MIN_INTERVAL: Duration = Duration::from_secs(5);

// ── Commands sent to plugin actor ──────────────────────────

pub(super) enum PluginCommand {
    WritePoint {
        name: String,
        value: f64,
        reply: oneshot::Sender<Result<(), String>>,
    },
    GetStatus {
        reply: oneshot::Sender<i32>,
    },
    Shutdown,
}

// ── Handle to a running plugin actor ───────────────────────

pub(super) struct PluginHandle {
    pub(super) cmd_tx: mpsc::UnboundedSender<PluginCommand>,
}

// ── Plugin Actor Loop ──────────────────────────────────────

pub(super) async fn run_plugin_actor(
    name: String,
    mut plugin: PluginInstance,
    mut cmd_rx: mpsc::UnboundedReceiver<PluginCommand>,
    scan_interval: Duration,
    monitor: Arc<MonitorCollector>,
) {
    let mut interval = tokio::time::interval(scan_interval);
    let mut last_reconnect = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = interval.tick() => {
                match plugin.scan_points().await {
                    Ok(0) => {
                        monitor.record_scan(&name);
                        if let Ok(s) = plugin.get_status().await {
                            monitor.set_connection_state(&name, s as i32);
                        }
                    }
                    Ok(code) => {
                        monitor.record_error(&name, &format!("scan_points returned code {}", code));
                        log::warn!("[{}] scan_points: {}", name, code);
                        let status = plugin.get_status().await.unwrap_or(0);
                        monitor.set_connection_state(&name, status as i32);
                        if should_reconnect(code, status, last_reconnect.elapsed(), RECONNECT_MIN_INTERVAL)
                        {
                            last_reconnect = std::time::Instant::now();
                            log::info!("[{}] link lost, attempting reconnect...", name);
                            match plugin.connect().await {
                                Ok(0) => {
                                    monitor.set_connection_state(&name, 2);
                                    log::info!("[{}] reconnected", name);
                                }
                                Ok(r) => {
                                    monitor.record_error(&name, &format!("reconnect failed code {}", r));
                                    log::warn!("[{}] reconnect failed: {}", name, r);
                                    let s = plugin.get_status().await.unwrap_or(0);
                                    monitor.set_connection_state(&name, s as i32);
                                }
                                Err(e) => {
                                    monitor.record_error(&name, &format!("reconnect error: {}", e));
                                    log::warn!("[{}] reconnect error: {}", name, e);
                                    monitor.set_connection_state(&name, 0);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        monitor.record_error(&name, &e.to_string());
                        log::error!("[{}] scan_points error: {}", name, e);
                        let s = plugin.get_status().await.unwrap_or(0);
                        monitor.set_connection_state(&name, s as i32);
                    }
                }
            }
            cmd = cmd_rx.recv() => match cmd {
                Some(PluginCommand::WritePoint {
                    name: pt,
                    value,
                    reply,
                }) => {
                    let r = match plugin.write_point(&pt, value).await {
                        Ok(0) => Ok(()),
                        Ok(c) => Err(format!("code:{}", c)),
                        Err(e) => Err(e.to_string()),
                    };
                    let _ = reply.send(r);
                }
                Some(PluginCommand::GetStatus { reply }) => {
                    let s = plugin.get_status().await.unwrap_or(u32::MAX) as i32;
                    monitor.set_connection_state(&name, s);
                    let _ = reply.send(s);
                }
                Some(PluginCommand::Shutdown) => {
                    let _ = plugin.disconnect().await;
                    monitor.set_connection_state(&name, 0);
                    break;
                }
                None => break,
            },
        }
    }
    log::info!("Plugin '{}' actor stopped", name);
}
