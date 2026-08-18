use crate::redundancy::engine::HeartbeatInfo;
use crate::types::PointValue;
use hmi_io_config::NodeRole;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use sync_util::MutexExt;

pub const MAX_EVENTS: usize = 100;
pub const MAX_RTT_HISTORY: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
    Standby,
    Active,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatDecision {
    KeepStandby,
    Promote,
    ClaimFailback,
}

/// 启动时根据静态角色与对端探测结果决定初始状态。
pub fn decide_initial_state(role: NodeRole, peer_reachable: bool, peer_active: bool) -> NodeState {
    match role {
        NodeRole::Primary => {
            if peer_reachable && peer_active {
                NodeState::Standby
            } else {
                NodeState::Active
            }
        }
        NodeRole::Backup => NodeState::Standby,
    }
}

/// 回切稳定期需要的心跳次数（向上取整，至少 1）。
pub fn required_stable_beats(failback_delay_ms: u64, heartbeat_interval_ms: u64) -> u32 {
    let interval = heartbeat_interval_ms.max(1);
    (failback_delay_ms.div_ceil(interval).max(1)) as u32
}

/// 采集不健康触发升主的决策：需达到阈值且冷却期已过。
pub fn should_promote_unhealthy(unhealthy_reports: u32, threshold: u32, cooldown_ok: bool) -> bool {
    cooldown_ok && unhealthy_reports >= threshold.max(1)
}

/// 心跳丢失升主的决策：失败次数达阈值且对端 WS 端口 TCP 探测不可达。
/// （TCP 探测的开销判定由引擎侧控制：未达阈值不探测。）
pub fn should_promote_on_heartbeat_loss(
    failures: u32,
    threshold: u32,
    peer_tcp_reachable: bool,
) -> bool {
    failures >= threshold.max(1) && !peer_tcp_reachable
}

/// 回切时机决策：主节点、对端活跃、稳定心跳数达回切周期。
pub fn should_attempt_failback(
    role: NodeRole,
    peer_active: bool,
    stable_beats: u32,
    failback_delay_ms: u64,
    heartbeat_interval_ms: u64,
) -> bool {
    role == NodeRole::Primary
        && peer_active
        && stable_beats >= required_stable_beats(failback_delay_ms, heartbeat_interval_ms)
}

/// 对端心跳陈旧判定：超过 3 个心跳周期（至少 3s）未收到心跳。
pub fn is_peer_stale(last_seen_ms: u64, now_ms: u64, heartbeat_interval_ms: u64) -> bool {
    now_ms.saturating_sub(last_seen_ms) > (heartbeat_interval_ms * 3).max(3_000)
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerStatus {
    pub reachable: bool,
    pub active: bool,
    pub node_id: String,
    pub config_version: u64,
    pub last_seen_ms: u64,
    pub rtt_ms: u64,
    pub rtt_avg_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStats {
    pub last_sync_ms: u64,
    pub points_received: u64,
    pub points_pushed: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedundancyEvent {
    pub time_ms: u64,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedundancyStatus {
    pub enabled: bool,
    pub node_id: String,
    pub role: String,
    pub state: String,
    pub config_version: u64,
    pub uptime_ms: u64,
    pub peer: PeerStatus,
    pub sync: SyncStats,
    pub events: Vec<RedundancyEvent>,
    pub rtt_history: Vec<u64>,
    pub synced_points: Vec<PointValue>,
    pub split_brain: bool,
    pub failover_count: u64,
    pub heartbeat_failures: u32,
    pub unhealthy_reports: u32,
}

struct RedundancyStateInner {
    enabled: bool,
    node_id: String,
    role: NodeRole,
    state: NodeState,
    config_version: u64,
    peer: PeerStatus,
    sync: SyncStats,
    events: VecDeque<RedundancyEvent>,
    rtt_history: VecDeque<u64>,
    synced_points: HashMap<String, PointValue>,
    split_brain: bool,
    failover_count: u64,
    heartbeat_failures: u32,
    stable_heartbeats: u32,
    rtt_sum: u64,
    rtt_count: u32,
    peer_reported_reachable: bool,
    unhealthy_reports: u32,
    last_promotion_ms: u64,
}

#[derive(Clone)]
pub struct RedundancyState {
    inner: Arc<Mutex<RedundancyStateInner>>,
    started: std::time::Instant,
}

impl RedundancyState {
    pub fn new(enabled: bool, node_id: String, role: NodeRole) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RedundancyStateInner {
                enabled,
                node_id,
                role,
                state: NodeState::Standby,
                config_version: 0,
                peer: PeerStatus {
                    reachable: false,
                    active: false,
                    node_id: String::new(),
                    config_version: 0,
                    last_seen_ms: 0,
                    rtt_ms: 0,
                    rtt_avg_ms: 0,
                },
                sync: SyncStats {
                    last_sync_ms: 0,
                    points_received: 0,
                    points_pushed: 0,
                },
                events: VecDeque::with_capacity(MAX_EVENTS),
                rtt_history: VecDeque::with_capacity(MAX_RTT_HISTORY),
                synced_points: HashMap::new(),
                split_brain: false,
                failover_count: 0,
                heartbeat_failures: 0,
                stable_heartbeats: 0,
                rtt_sum: 0,
                rtt_count: 0,
                peer_reported_reachable: false,
                unhealthy_reports: 0,
                last_promotion_ms: 0,
            })),
            started: std::time::Instant::now(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.inner.lock_recover().enabled
    }

    pub fn role(&self) -> NodeRole {
        self.inner.lock_recover().role
    }

    pub fn node_id(&self) -> String {
        self.inner.lock_recover().node_id.clone()
    }

    pub fn state(&self) -> NodeState {
        self.inner.lock_recover().state
    }

    pub fn set_state(&self, state: NodeState) {
        let mut inner = self.inner.lock_recover();
        inner.state = state;
        if state == NodeState::Active {
            inner.heartbeat_failures = 0;
            inner.stable_heartbeats = 0;
            inner.unhealthy_reports = 0;
        }
    }

    pub fn config_version(&self) -> u64 {
        self.inner.lock_recover().config_version
    }

    pub fn set_config_version(&self, v: u64) {
        self.inner.lock_recover().config_version = v;
    }

    pub fn heartbeat_failures(&self) -> u32 {
        self.inner.lock_recover().heartbeat_failures
    }

    pub fn record_heartbeat_failure(&self) {
        let mut inner = self.inner.lock_recover();
        if inner.heartbeat_failures == 0 {
            inner.events.push_back(RedundancyEvent {
                time_ms: now_ms(),
                kind: "heartbeat_lost".into(),
                message: "heartbeat to peer lost".into(),
            });
            trim(&mut inner.events);
        }
        inner.heartbeat_failures += 1;
        inner.stable_heartbeats = 0;
    }

    pub fn record_heartbeat_ok(&self, rtt_ms: u64, peer: HeartbeatInfo) {
        let mut inner = self.inner.lock_recover();
        if inner.heartbeat_failures > 0 {
            inner.events.push_back(RedundancyEvent {
                time_ms: now_ms(),
                kind: "heartbeat_restored".into(),
                message: format!("heartbeat restored (rtt {}ms)", rtt_ms),
            });
            trim(&mut inner.events);
        }
        inner.heartbeat_failures = 0;
        inner.stable_heartbeats += 1;
        inner.split_brain = false;
        inner.peer.reachable = true;
        inner.peer.active = peer.state == "active";
        inner.peer.node_id = peer.node_id;
        inner.peer.config_version = peer.config_version;
        inner.peer.last_seen_ms = now_ms();
        inner.peer.rtt_ms = rtt_ms;
        inner.rtt_sum += rtt_ms;
        inner.rtt_count += 1;
        inner.peer.rtt_avg_ms = inner.rtt_sum / inner.rtt_count as u64;
        inner.rtt_history.push_back(rtt_ms);
        while inner.rtt_history.len() > MAX_RTT_HISTORY {
            inner.rtt_history.pop_front();
        }
        if !inner.peer_reported_reachable {
            inner.peer_reported_reachable = true;
        }
    }

    pub fn stable_heartbeats(&self) -> u32 {
        self.inner.lock_recover().stable_heartbeats
    }

    pub fn reset_stable_heartbeats(&self) {
        self.inner.lock_recover().stable_heartbeats = 0;
    }

    pub fn record_peer_seen(&self, rtt_ms: u64) {
        let mut inner = self.inner.lock_recover();
        if !inner.peer_reported_reachable {
            inner.events.push_back(RedundancyEvent {
                time_ms: now_ms(),
                kind: "peer_lost".into(),
                message: "peer node reachable again".into(),
            });
            trim(&mut inner.events);
        }
        inner.peer_reported_reachable = true;
        inner.peer.reachable = true;
        inner.peer.last_seen_ms = now_ms();
        if rtt_ms > 0 {
            inner.peer.rtt_ms = rtt_ms;
        }
    }

    pub fn mark_peer_stale(&self) {
        let mut inner = self.inner.lock_recover();
        if inner.peer_reported_reachable {
            inner.events.push_back(RedundancyEvent {
                time_ms: now_ms(),
                kind: "peer_lost".into(),
                message: "peer node unreachable".into(),
            });
            trim(&mut inner.events);
        }
        inner.peer_reported_reachable = false;
        inner.peer.reachable = false;
    }

    pub fn apply_synced(&self, points: Vec<PointValue>) {
        let mut inner = self.inner.lock_recover();
        for pv in points {
            inner.sync.points_received += 1;
            inner.synced_points.insert(pv.id.clone(), pv);
        }
        inner.sync.last_sync_ms = now_ms();
    }

    pub fn update_sync_pushed(&self, count: usize) {
        let mut inner = self.inner.lock_recover();
        inner.sync.points_pushed += count as u64;
        inner.sync.last_sync_ms = now_ms();
    }

    pub fn set_split_brain(&self, on: bool) {
        let mut inner = self.inner.lock_recover();
        if inner.split_brain != on {
            inner.split_brain = on;
            inner.events.push_back(RedundancyEvent {
                time_ms: now_ms(),
                kind: "split_brain".into(),
                message: if on {
                    "split-brain detected: both nodes active".into()
                } else {
                    "split-brain resolved".into()
                },
            });
            trim(&mut inner.events);
        }
    }

    pub fn record_event(&self, kind: &str, message: impl Into<String>) {
        let mut inner = self.inner.lock_recover();
        inner.events.push_back(RedundancyEvent {
            time_ms: now_ms(),
            kind: kind.to_string(),
            message: message.into(),
        });
        trim(&mut inner.events);
    }

    pub fn increment_failover_count(&self) {
        let mut inner = self.inner.lock_recover();
        inner.failover_count += 1;
        inner.last_promotion_ms = now_ms();
    }

    pub fn record_unhealthy_report(&self) {
        self.inner.lock_recover().unhealthy_reports += 1;
    }

    pub fn reset_unhealthy_reports(&self) {
        self.inner.lock_recover().unhealthy_reports = 0;
    }

    pub fn unhealthy_reports(&self) -> u32 {
        self.inner.lock_recover().unhealthy_reports
    }

    pub fn last_promotion_ms(&self) -> u64 {
        self.inner.lock_recover().last_promotion_ms
    }

    pub fn get_status(&self) -> RedundancyStatus {
        let inner = self.inner.lock_recover();
        RedundancyStatus {
            enabled: inner.enabled,
            node_id: inner.node_id.clone(),
            role: inner.role.as_str().to_string(),
            state: match inner.state {
                NodeState::Active => "active",
                NodeState::Standby => "standby",
            }
            .to_string(),
            config_version: inner.config_version,
            uptime_ms: self.started.elapsed().as_millis() as u64,
            peer: inner.peer.clone(),
            sync: inner.sync.clone(),
            events: inner.events.iter().rev().cloned().collect(),
            rtt_history: inner.rtt_history.iter().copied().collect(),
            synced_points: inner.synced_points.values().cloned().collect(),
            split_brain: inner.split_brain,
            failover_count: inner.failover_count,
            heartbeat_failures: inner.heartbeat_failures,
            unhealthy_reports: inner.unhealthy_reports,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn trim(events: &mut VecDeque<RedundancyEvent>) {
    while events.len() > MAX_EVENTS {
        events.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PointValue;

    #[test]
    fn initial_state_primary_peer_active_is_standby() {
        assert_eq!(
            decide_initial_state(NodeRole::Primary, true, true),
            NodeState::Standby
        );
        assert_eq!(
            decide_initial_state(NodeRole::Primary, false, false),
            NodeState::Active
        );
        assert_eq!(
            decide_initial_state(NodeRole::Backup, true, true),
            NodeState::Standby
        );
        assert_eq!(
            decide_initial_state(NodeRole::Backup, false, false),
            NodeState::Standby
        );
    }

    #[test]
    fn required_stable_beats_rounds_up() {
        assert_eq!(required_stable_beats(30_000, 1_000), 30);
        assert_eq!(required_stable_beats(10_000, 3_000), 4);
    }

    #[test]
    fn event_ring_trims_to_max() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        for i in 0..(MAX_EVENTS + 10) {
            s.record_event("test", format!("e{}", i));
        }
        let status = s.get_status();
        assert_eq!(status.events.len(), MAX_EVENTS);
        assert_eq!(status.events[0].message, format!("e{}", MAX_EVENTS + 9));
    }

    #[test]
    fn apply_synced_tracks_latest_values() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        s.apply_synced(vec![PointValue::new("mb1:P1", 1.0, "good", 1000)]);
        s.apply_synced(vec![PointValue::new("mb1:P1", 2.0, "good", 2000)]);
        let status = s.get_status();
        assert_eq!(status.synced_points.len(), 1);
        assert!((status.synced_points[0].numeric_value().unwrap() - 2.0).abs() < 0.01);
    }

    #[test]
    fn heartbeat_failure_counts_and_events() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        s.record_heartbeat_failure();
        s.record_heartbeat_failure();
        assert_eq!(s.heartbeat_failures(), 2);
        let status = s.get_status();
        assert!(status.events.iter().any(|e| e.kind == "heartbeat_lost"));
        s.record_heartbeat_ok(
            10,
            HeartbeatInfo {
                node_id: "node-b".into(),
                role: "backup".into(),
                state: "active".into(),
                config_version: 1,
                uptime_ms: 1000,
                data_healthy: true,
                plugins_total: 1,
                plugins_connected: 1,
            },
        );
        assert_eq!(s.heartbeat_failures(), 0);
        let status = s.get_status();
        assert!(status.events.iter().any(|e| e.kind == "heartbeat_restored"));
    }

    #[test]
    fn unhealthy_reports_count_and_reset() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        s.record_unhealthy_report();
        s.record_unhealthy_report();
        assert_eq!(s.unhealthy_reports(), 2);
        s.reset_unhealthy_reports();
        assert_eq!(s.unhealthy_reports(), 0);
    }

    #[test]
    fn should_promote_unhealthy_requires_threshold_and_cooldown() {
        assert!(!should_promote_unhealthy(2, 3, true));
        assert!(should_promote_unhealthy(3, 3, true));
        assert!(!should_promote_unhealthy(3, 3, false));
    }

    #[test]
    fn heartbeat_loss_promotion_requires_threshold_and_tcp_down() {
        assert!(!should_promote_on_heartbeat_loss(2, 3, false));
        assert!(should_promote_on_heartbeat_loss(3, 3, false));
        // 对端 TCP 可达（第二通道存活）不升主
        assert!(!should_promote_on_heartbeat_loss(3, 3, true));
        // 阈值为 0 时按 1 处理
        assert!(!should_promote_on_heartbeat_loss(0, 0, false));
        assert!(should_promote_on_heartbeat_loss(1, 0, false));
    }

    #[test]
    fn failback_requires_primary_role_peer_active_and_stable_beats() {
        // 主节点、对端活跃、稳定心跳 30 拍（30s/1s）→ 回切
        assert!(should_attempt_failback(
            NodeRole::Primary,
            true,
            30,
            30_000,
            1_000
        ));
        // 备节点不主动回切
        assert!(!should_attempt_failback(
            NodeRole::Backup,
            true,
            30,
            30_000,
            1_000
        ));
        // 对端非活跃不回切
        assert!(!should_attempt_failback(
            NodeRole::Primary,
            false,
            30,
            30_000,
            1_000
        ));
        // 稳定心跳不足不回切
        assert!(!should_attempt_failback(
            NodeRole::Primary,
            true,
            29,
            30_000,
            1_000
        ));
        // 回切周期向上取整：10s 延迟 / 3s 心跳 → 4 拍
        assert!(should_attempt_failback(
            NodeRole::Primary,
            true,
            4,
            10_000,
            3_000
        ));
        assert!(!should_attempt_failback(
            NodeRole::Primary,
            true,
            3,
            10_000,
            3_000
        ));
    }

    #[test]
    fn peer_stale_after_three_heartbeat_periods() {
        assert!(!is_peer_stale(0, 2_999, 1_000));
        assert!(is_peer_stale(0, 3_001, 1_000));
        // 周期过短时下限 3s
        assert!(!is_peer_stale(0, 2_999, 100));
        assert!(is_peer_stale(0, 3_001, 100));
    }

    #[test]
    fn promotion_records_timestamp() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        assert_eq!(s.last_promotion_ms(), 0);
        s.increment_failover_count();
        assert!(s.last_promotion_ms() > 0);
    }
}
