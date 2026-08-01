//! MonitorCollector - thread-safe shared state for all plugin monitoring data

use crate::types::*;
use hmi_io_point::types::PointValue;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_PACKETS_PER_PLUGIN: usize = 500;
/// Rolling history kept for trend charts (~15 min at 1 Hz)
const MAX_HISTORY_SAMPLES: usize = 900;

struct PluginMonitorState {
    status: PluginStatus,
    points: HashMap<String, LivePointInfo>,
    packets: Vec<PacketLogEntry>,
    point_configs: HashMap<String, (String, String, String, f64, f64, String)>,
    /// Reverse mapping: protocol address -> variable_id
    addr_to_var: HashMap<String, String>,
}

pub struct MonitorCollector {
    inner: Mutex<MonitorInner>,
}

struct MonitorInner {
    server_start: Instant,
    plugins: HashMap<String, PluginMonitorState>,
    ws_client_count: usize,
    history: VecDeque<HistorySample>,
}

impl MonitorCollector {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(MonitorInner {
                server_start: Instant::now(),
                plugins: HashMap::new(),
                ws_client_count: 0,
                history: VecDeque::with_capacity(MAX_HISTORY_SAMPLES),
            }),
        })
    }

    pub fn register_plugin(
        self: &Arc<Self>,
        name: &str,
        wasm_file: &str,
        points: &[(String, String, String, String, f64, f64, String)],
    ) {
        let mut inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        let mut point_map = HashMap::new();
        let mut config_map = HashMap::new();
        let mut addr_map = HashMap::new();
        for (var_id, addr, var_type, data_type, scale, offset, byte_order) in points {
            point_map.insert(
                var_id.clone(),
                LivePointInfo {
                    variable_id: var_id.clone(),
                    address: addr.clone(),
                    var_type: var_type.clone(),
                    value: serde_json::Value::Null,
                    quality: "unknown".into(),
                    timestamp_ms: 0,
                    age_ms: 0,
                    data_type: data_type.clone(),
                    byte_order: byte_order.clone(),
                    scale: *scale,
                    offset_val: *offset,
                },
            );
            config_map.insert(
                var_id.clone(),
                (
                    addr.clone(),
                    var_type.clone(),
                    data_type.clone(),
                    *scale,
                    *offset,
                    byte_order.clone(),
                ),
            );
            if !addr.is_empty() {
                addr_map.insert(addr.clone(), var_id.clone());
            }
        }
        inner.plugins.insert(
            name.to_string(),
            PluginMonitorState {
                status: PluginStatus {
                    name: name.to_string(),
                    wasm_file: wasm_file.to_string(),
                    connection_state: 1,
                    connection_label: "connecting".into(),
                    scan_count: 0,
                    error_count: 0,
                    last_scan_time_ms: 0,
                    last_error: String::new(),
                    last_error_time_ms: 0,
                    uptime_ms: 0,
                    start_time_ms: now_ms,
                },
                points: point_map,
                packets: Vec::with_capacity(MAX_PACKETS_PER_PLUGIN),
                point_configs: config_map,
                addr_to_var: addr_map,
            },
        );
    }

    pub fn set_connection_state(self: &Arc<Self>, plugin_name: &str, state: i32) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(p) = inner.plugins.get_mut(plugin_name) {
            p.status.connection_state = state;
            p.status.connection_label = match state {
                0 => "disconnected".into(),
                1 => "connecting".into(),
                2 => "connected".into(),
                3 => "error".into(),
                _ => "unknown".into(),
            };
        }
    }

    pub fn record_scan(self: &Arc<Self>, plugin_name: &str) {
        let mut inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        if let Some(p) = inner.plugins.get_mut(plugin_name) {
            p.status.scan_count += 1;
            p.status.last_scan_time_ms = now_ms;
            p.status.uptime_ms = now_ms - p.status.start_time_ms;
        }
    }

    pub fn record_error(self: &Arc<Self>, plugin_name: &str, error: &str) {
        let mut inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        if let Some(p) = inner.plugins.get_mut(plugin_name) {
            p.status.error_count += 1;
            p.status.last_error = error.to_string();
            p.status.last_error_time_ms = now_ms;
            p.status.uptime_ms = now_ms - p.status.start_time_ms;
        }
    }

    fn now_epoch_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    pub fn update_point_value(self: &Arc<Self>, plugin_name: &str, pv: &PointValue) {
        let mut inner = self.inner.lock().unwrap();
        let now_epoch = Self::now_epoch_ms();
        if let Some(p) = inner.plugins.get_mut(plugin_name) {
            // Resolve point identity: try variable_id first, then address reverse lookup
            let var_id = if p.points.contains_key(&pv.id) {
                pv.id.clone()
            } else if let Some(mapped) = p.addr_to_var.get(&pv.id) {
                mapped.clone()
            } else {
                pv.id.clone()
            };

            if let Some(existing) = p.points.get_mut(&var_id) {
                existing.value = pv.value.clone();
                existing.quality = pv.quality.clone();
                existing.timestamp_ms = pv.timestamp;
                existing.age_ms = now_epoch.saturating_sub(pv.timestamp);
            } else {
                // Point not pre-registered - add dynamically with config lookup
                let (addr, vtype, dtype, scale, offset, border) =
                    p.point_configs.get(&var_id).cloned().unwrap_or_else(|| {
                        // Try address-based config lookup as fallback
                        p.addr_to_var
                            .get(&pv.id)
                            .and_then(|vid| p.point_configs.get(vid))
                            .cloned()
                            .unwrap_or_else(|| {
                                (
                                    String::new(),
                                    "AI".into(),
                                    "uint16".into(),
                                    1.0,
                                    0.0,
                                    "big_endian".into(),
                                )
                            })
                    });
                p.points.insert(
                    var_id.clone(),
                    LivePointInfo {
                        variable_id: var_id,
                        address: addr,
                        var_type: vtype,
                        value: pv.value.clone(),
                        quality: pv.quality.clone(),
                        timestamp_ms: pv.timestamp,
                        age_ms: now_epoch.saturating_sub(pv.timestamp),
                        data_type: dtype,
                        byte_order: border,
                        scale,
                        offset_val: offset,
                    },
                );
            }
        }
    }

    pub fn log_packet(
        self: &Arc<Self>,
        plugin_name: &str,
        direction: &str,
        protocol: &str,
        hex_dump: &str,
        summary: &str,
    ) {
        let mut inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        if let Some(p) = inner.plugins.get_mut(plugin_name) {
            let byte_count = if hex_dump.is_empty() {
                0
            } else {
                hex_dump.split_whitespace().count()
            };
            let entry = PacketLogEntry {
                timestamp_ms: now_ms,
                direction: direction.to_string(),
                protocol: protocol.to_string(),
                length: byte_count,
                hex_dump: hex_dump.to_string(),
                summary: summary.to_string(),
            };
            p.packets.push(entry);
            if p.packets.len() > MAX_PACKETS_PER_PLUGIN {
                let excess = p.packets.len() - MAX_PACKETS_PER_PLUGIN;
                p.packets.drain(0..excess);
            }
        }
    }

    pub fn ws_client_connected(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        inner.ws_client_count += 1;
    }

    pub fn ws_client_disconnected(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        inner.ws_client_count = inner.ws_client_count.saturating_sub(1);
    }

    pub fn get_snapshot(self: &Arc<Self>) -> MonitorSnapshot {
        let inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        let mut plugins: Vec<PluginStatus> = inner
            .plugins
            .values()
            .map(|p| {
                let mut s = p.status.clone();
                s.uptime_ms = now_ms - s.start_time_ms;
                s
            })
            .collect();
        plugins.sort_by(|a, b| a.name.cmp(&b.name));
        MonitorSnapshot {
            server_uptime_ms: now_ms,
            total_scans: plugins.iter().map(|p| p.scan_count).sum(),
            total_errors: plugins.iter().map(|p| p.error_count).sum(),
            total_points: inner.plugins.values().map(|p| p.points.len()).sum(),
            active_ws_clients: inner.ws_client_count,
            plugins,
        }
    }

    pub fn get_plugin_status(self: &Arc<Self>, plugin_name: &str) -> Option<PluginStatus> {
        let inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        inner.plugins.get(plugin_name).map(|p| {
            let mut s = p.status.clone();
            s.uptime_ms = now_ms - s.start_time_ms;
            s
        })
    }

    pub fn get_live_points(self: &Arc<Self>, plugin_name: &str) -> Vec<LivePointInfo> {
        let inner = self.inner.lock().unwrap();
        let now_ms = inner.server_start.elapsed().as_millis() as u64;
        if let Some(p) = inner.plugins.get(plugin_name) {
            let mut points: Vec<LivePointInfo> = p
                .points
                .values()
                .map(|pt| {
                    let mut pt = pt.clone();
                    pt.age_ms = now_ms.saturating_sub(pt.timestamp_ms);
                    pt
                })
                .collect();
            points.sort_by(|a, b| a.variable_id.cmp(&b.variable_id));
            points
        } else {
            Vec::new()
        }
    }

    pub fn get_packets(self: &Arc<Self>, plugin_name: &str, limit: usize) -> Vec<PacketLogEntry> {
        let inner = self.inner.lock().unwrap();
        if let Some(p) = inner.plugins.get(plugin_name) {
            let start = if p.packets.len() > limit {
                p.packets.len() - limit
            } else {
                0
            };
            p.packets[start..].to_vec()
        } else {
            Vec::new()
        }
    }

    /// Capture a timestamped snapshot of scan/error counters into the rolling history.
    /// Called periodically by the web server sampler task so trends stay continuous
    /// even while no UI client is polling.
    pub fn sample(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        let mut per_plugin: Vec<PluginHistorySample> = inner
            .plugins
            .values()
            .map(|p| PluginHistorySample {
                name: p.status.name.clone(),
                scans: p.status.scan_count,
                errors: p.status.error_count,
            })
            .collect();
        per_plugin.sort_by(|a, b| a.name.cmp(&b.name));
        let sample = HistorySample {
            timestamp_ms: Self::now_epoch_ms(),
            total_scans: per_plugin.iter().map(|p| p.scans).sum(),
            total_errors: per_plugin.iter().map(|p| p.errors).sum(),
            per_plugin,
        };
        inner.history.push_back(sample);
        while inner.history.len() > MAX_HISTORY_SAMPLES {
            inner.history.pop_front();
        }
    }

    /// Newest-first history samples, at most `limit` entries.
    pub fn get_history(self: &Arc<Self>, limit: usize, scan_interval_ms: u64) -> MonitorHistory {
        let inner = self.inner.lock().unwrap();
        let skip = inner.history.len().saturating_sub(limit.max(1));
        let samples: Vec<HistorySample> = inner.history.iter().skip(skip).rev().cloned().collect();
        MonitorHistory {
            samples,
            scan_interval_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_collector() -> Arc<MonitorCollector> {
        let c = MonitorCollector::new();
        c.register_plugin(
            "modbus_tcp",
            "modbus_tcp.wasm",
            &[(
                "P1".into(),
                "coil:0".into(),
                "DI".into(),
                "bool".into(),
                1.0,
                0.0,
                "ABCD".into(),
            )],
        );
        c.register_plugin(
            "iec104",
            "iec104.wasm",
            &[(
                "P2".into(),
                "1001".into(),
                "AI".into(),
                "float32".into(),
                1.0,
                0.0,
                "ABCD".into(),
            )],
        );
        c
    }

    #[test]
    fn sample_captures_counters() {
        let c = make_collector();
        c.record_scan("modbus_tcp");
        c.record_scan("modbus_tcp");
        c.record_error("modbus_tcp", "timeout");
        c.record_scan("iec104");
        c.sample();

        let h = c.get_history(10, 500);
        assert_eq!(h.samples.len(), 1);
        let s = &h.samples[0];
        assert_eq!(s.total_scans, 3);
        assert_eq!(s.total_errors, 1);
        assert_eq!(s.per_plugin.len(), 2);
        let mb = s
            .per_plugin
            .iter()
            .find(|p| p.name == "modbus_tcp")
            .unwrap();
        assert_eq!(mb.scans, 2);
        assert_eq!(mb.errors, 1);
        assert!(s.timestamp_ms > 1_000_000_000_000);
    }

    #[test]
    fn history_prunes_old_samples() {
        let c = make_collector();
        for _ in 0..MAX_HISTORY_SAMPLES + 10 {
            c.sample();
        }
        assert_eq!(
            c.get_history(usize::MAX, 500).samples.len(),
            MAX_HISTORY_SAMPLES
        );
    }

    #[test]
    fn get_history_returns_newest_first_with_limit() {
        let c = make_collector();
        for _ in 0..10 {
            c.record_scan("modbus_tcp");
            c.sample();
        }
        let h = c.get_history(3, 500);
        assert_eq!(h.samples.len(), 3);
        assert_eq!(h.scan_interval_ms, 500);
        // Newest first
        assert!(h.samples[0].timestamp_ms >= h.samples[1].timestamp_ms);
        assert!(h.samples[1].timestamp_ms >= h.samples[2].timestamp_ms);
        // Newest sample carries all 10 scans
        assert_eq!(h.samples[0].total_scans, 10);
    }
}
