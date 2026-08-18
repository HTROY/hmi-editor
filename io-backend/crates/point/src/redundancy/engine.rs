use crate::manager::PointManager;
use crate::redundancy::state::{
    decide_initial_state, is_peer_stale, should_attempt_failback, should_promote_on_heartbeat_loss,
    should_promote_unhealthy, NodeState, RedundancyState,
};
use crate::types::{PointValue, WsDataMessage};
use hmi_io_config::{NodeRole, RedundancyConfig};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatInfo {
    pub node_id: String,
    pub role: String,
    pub state: String,
    pub config_version: u64,
    pub uptime_ms: u64,
    pub data_healthy: bool,
    pub plugins_total: usize,
    pub plugins_connected: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncBody {
    pub node_id: String,
    pub config_version: u64,
    pub points: Vec<PointValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimBody {
    pub node_id: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigPushBody {
    pub node_id: String,
    pub config: serde_json::Value,
}

/// 引擎向 bin 装配层发出的角色命令。
#[derive(Debug)]
pub enum RoleCommand {
    Promote,
    Demote,
    /// 回切前探测本机数据就绪（bin 启动插件验证后回执）。
    ProbeData {
        reply: tokio::sync::oneshot::Sender<bool>,
    },
}

pub struct RedundancyEngine {
    config: RedundancyConfig,
    state: RedundancyState,
    point_manager: Arc<Mutex<PointManager>>,
    broadcast_rx: Mutex<Option<broadcast::Receiver<String>>>,
    broadcast_tx: broadcast::Sender<String>,
    client: reqwest::Client,
    health_provider: Mutex<Option<Box<dyn Fn() -> (usize, usize, bool) + Send + Sync>>>,
    role_tx: Mutex<Option<mpsc::UnboundedSender<RoleCommand>>>,
    started: Instant,
}

impl RedundancyEngine {
    pub fn new(
        config: RedundancyConfig,
        point_manager: Arc<Mutex<PointManager>>,
        broadcast_rx: broadcast::Receiver<String>,
        broadcast_tx: broadcast::Sender<String>,
    ) -> Arc<Self> {
        let state = RedundancyState::new(config.enabled, config.node_id.clone(), config.role);
        Arc::new(Self {
            config,
            state,
            point_manager,
            broadcast_rx: Mutex::new(Some(broadcast_rx)),
            broadcast_tx,
            client: reqwest::Client::new(),
            health_provider: Mutex::new(None),
            role_tx: Mutex::new(None),
            started: Instant::now(),
        })
    }

    pub fn state(&self) -> &RedundancyState {
        &self.state
    }

    pub fn set_role_tx(&self, tx: mpsc::UnboundedSender<RoleCommand>) {
        *self.role_tx.lock().unwrap() = Some(tx);
    }

    /// 注入本机插件健康评估闭包：(总实例数, 已连接数, data_healthy)。
    pub fn set_health_provider(&self, f: Box<dyn Fn() -> (usize, usize, bool) + Send + Sync>) {
        *self.health_provider.lock().unwrap() = Some(f);
    }

    fn data_health(&self) -> (usize, usize, bool) {
        self.health_provider
            .lock()
            .unwrap()
            .as_ref()
            .map(|f| f())
            .unwrap_or((0, 0, true))
    }

    /// 单机模式恒为 true；冗余模式下看运行态。
    pub fn is_active(&self) -> bool {
        if !self.config.enabled {
            true
        } else {
            self.state.state() == NodeState::Active
        }
    }

    pub fn set_config_version(&self, v: u64) {
        self.state.set_config_version(v);
    }

    /// 启动时探测对端并决定初始运行态。
    pub async fn decide_initial_state(&self) -> NodeState {
        if !self.config.enabled {
            return NodeState::Active;
        }
        match self.probe_peer().await {
            Some(hb) => decide_initial_state(self.config.role, true, hb.state == "active"),
            None => decide_initial_state(self.config.role, false, false),
        }
    }

    pub fn apply_initial_state(&self, state: NodeState) {
        self.state.set_state(state);
        self.point_manager
            .lock()
            .unwrap()
            .set_active(state == NodeState::Active);
        if state == NodeState::Active {
            self.state.record_event("promoted", "initial state: active");
        } else {
            self.state.record_event("started", "initial state: standby");
        }
    }

    pub async fn run(self: &Arc<Self>) {
        if !self.config.enabled {
            log::info!("Redundancy disabled, engine idle");
            // 单机模式引擎驻留，避免 bin 的 select! 因任务结束而触发退出
            loop {
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }
        log::info!(
            "Redundancy engine started: node '{}' role {}",
            self.config.node_id,
            self.config.role.as_str()
        );
        // 值转发任务：订阅 Bridge broadcast，把 data 消息转成 /sync 推给对端
        let forward = self.clone();
        tokio::spawn(async move {
            forward.forward_loop().await;
        });

        let interval = Duration::from_millis(self.config.heartbeat_interval_ms.max(100));
        let mut tick = tokio::time::interval(interval);
        let snapshot = Duration::from_millis(self.config.full_snapshot_interval_ms.max(1000));
        let mut snapshot_tick = tokio::time::interval(snapshot);
        loop {
            tokio::select! {
                _ = tick.tick() => self.on_tick().await,
                _ = snapshot_tick.tick() => self.push_full_snapshot().await,
            }
        }
    }

    async fn on_tick(&self) {
        match self.state.state() {
            NodeState::Active => {
                // 对端（Standby）会主动心跳我们；只在状态页面显示对端是否在线
                let last_seen = self.state.get_status().peer.last_seen_ms;
                if is_peer_stale(last_seen, now_ms(), self.config.heartbeat_interval_ms) {
                    self.state.mark_peer_stale();
                }
            }
            NodeState::Standby => {
                let start = Instant::now();
                match self.probe_peer().await {
                    Some(hb) => {
                        let rtt = start.elapsed().as_millis() as u64;
                        self.state.record_heartbeat_ok(rtt, hb.clone());
                        if should_attempt_failback(
                            self.config.role,
                            hb.state == "active",
                            self.state.stable_heartbeats(),
                            self.config.failback_delay_ms,
                            self.config.heartbeat_interval_ms,
                        ) {
                            if self.probe_local_data().await {
                                self.claim_and_promote().await;
                            } else {
                                self.state.record_event(
                                    "error",
                                    "failback skipped: local data not ready",
                                );
                                self.state.reset_stable_heartbeats();
                            }
                        } else if !hb.data_healthy {
                            // 节点级采集健康触发：对端整机取不到数据
                            self.state.record_unhealthy_report();
                            let cooldown_ok = now_ms()
                                .saturating_sub(self.state.last_promotion_ms())
                                >= self.config.plugin_promotion_cooldown_ms;
                            if should_promote_unhealthy(
                                self.state.unhealthy_reports(),
                                self.config.plugin_unhealthy_threshold,
                                cooldown_ok,
                            ) {
                                self.claim_and_promote().await;
                            }
                        } else {
                            self.state.reset_unhealthy_reports();
                        }
                    }
                    None => {
                        self.state.record_heartbeat_failure();
                        // 达阈值才走第二通道 TCP 探测（对端 HTTP 故障期间不每拍探测）
                        let failures = self.state.heartbeat_failures();
                        if failures >= self.config.failover_threshold.max(1) {
                            let peer_tcp_reachable = self.probe_peer_tcp().await;
                            if should_promote_on_heartbeat_loss(
                                failures,
                                self.config.failover_threshold,
                                peer_tcp_reachable,
                            ) {
                                self.promote();
                            }
                        }
                    }
                }
            }
        }
    }

    async fn probe_peer(&self) -> Option<HeartbeatInfo> {
        let url = format!(
            "{}/api/redundancy/heartbeat",
            self.config.peer_url.trim_end_matches('/')
        );
        let timeout = Duration::from_millis(self.config.heartbeat_interval_ms.max(100));
        match self.client.get(&url).timeout(timeout).send().await {
            Ok(r) if r.status().is_success() => r.json::<HeartbeatInfo>().await.ok(),
            _ => None,
        }
    }

    /// 第二通道：TCP 探测对端 WS 端口（TCP 握手成功即视为可达，即使对端拒绝 WS 握手）。
    async fn probe_peer_tcp(&self) -> bool {
        let Ok(url) = reqwest::Url::parse(self.config.peer_url.trim_end_matches('/')) else {
            return false;
        };
        let Some(host) = url.host_str() else {
            return false;
        };
        match tokio::time::timeout(
            Duration::from_secs(1),
            tokio::net::TcpStream::connect((host, self.config.peer_ws_port)),
        )
        .await
        {
            Ok(Ok(_)) => true,
            _ => false,
        }
    }

    fn promote(&self) {
        self.state.set_state(NodeState::Active);
        self.state.increment_failover_count();
        self.state
            .record_event("promoted", "standby promoted to active");
        self.point_manager.lock().unwrap().set_active(true);
        if let Some(tx) = self.role_tx.lock().unwrap().as_ref() {
            let _ = tx.send(RoleCommand::Promote);
        }
        log::warn!(
            "Redundancy: node '{}' promoted to ACTIVE",
            self.config.node_id
        );
    }

    /// 回切前探测本机插件能否取到数据（由 bin 启动插件验证并回执）。
    async fn probe_local_data(&self) -> bool {
        let tx = { self.role_tx.lock().unwrap().clone() };
        let Some(tx) = tx else {
            return false;
        };
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        if tx.send(RoleCommand::ProbeData { reply: reply_tx }).is_err() {
            return false;
        }
        match tokio::time::timeout(Duration::from_secs(10), reply_rx).await {
            Ok(Ok(ok)) => ok,
            _ => false,
        }
    }

    fn demote(&self, reason: &str) {
        self.state.set_state(NodeState::Standby);
        self.state.record_event("demoted", reason.to_string());
        self.point_manager.lock().unwrap().set_active(false);
        // 让本机 WS 客户端立即断开并切到对端
        let msg = serde_json::json!({"type": "role", "state": "standby"}).to_string();
        let _ = self.broadcast_tx.send(msg);
        if let Some(tx) = self.role_tx.lock().unwrap().as_ref() {
            let _ = tx.send(RoleCommand::Demote);
        }
        log::warn!(
            "Redundancy: node '{}' demoted to STANDBY ({})",
            self.config.node_id,
            reason
        );
    }

    async fn claim_and_promote(&self) {
        let url = format!(
            "{}/api/redundancy/claim",
            self.config.peer_url.trim_end_matches('/')
        );
        let body = ClaimBody {
            node_id: self.config.node_id.clone(),
            role: self.config.role.as_str().to_string(),
        };
        let timeout = Duration::from_millis(self.config.heartbeat_interval_ms.max(100));
        match self
            .client
            .post(&url)
            .json(&body)
            .timeout(timeout)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json::<ClaimResult>().await {
                Ok(res) if res.accepted => {
                    self.state
                        .record_event("claim", "failback claim accepted by peer");
                    self.promote();
                }
                _ => {
                    self.state.record_event("claim", "failback claim rejected");
                    self.state.reset_stable_heartbeats();
                    self.state.reset_unhealthy_reports();
                }
            },
            _ => {
                self.state
                    .record_event("claim", "failback claim failed (peer unreachable)");
                self.state.reset_stable_heartbeats();
                self.state.reset_unhealthy_reports();
            }
        }
    }

    pub fn heartbeat_info(&self) -> HeartbeatInfo {
        let (total, connected, healthy) = self.data_health();
        HeartbeatInfo {
            node_id: self.state.node_id(),
            role: self.config.role.as_str().to_string(),
            state: match self.state.state() {
                NodeState::Active => "active",
                NodeState::Standby => "standby",
            }
            .to_string(),
            config_version: self.state.config_version(),
            uptime_ms: self.started.elapsed().as_millis() as u64,
            data_healthy: healthy,
            plugins_total: total,
            plugins_connected: connected,
        }
    }

    /// Active 节点被对端心跳访问时记录对端在线状态。
    pub fn record_peer_seen(&self, rtt_ms: u64) {
        if self.config.enabled {
            self.state.record_peer_seen(rtt_ms);
        }
    }

    pub fn handle_sync(&self, body: &SyncBody) -> Result<(), String> {
        if !self.config.enabled {
            return Err("redundancy disabled".into());
        }
        if body.config_version < self.state.config_version() {
            return Ok(()); // 旧版本，忽略
        }
        if self.state.state() == NodeState::Active {
            // 对端也在推值 => 对端也认为自己是 Active => 脑裂
            self.state.set_split_brain(true);
            self.state.record_event(
                "split_brain",
                format!("peer '{}' is also active", body.node_id),
            );
            if self.config.role == NodeRole::Backup {
                self.demote("split-brain resolved: peer is primary and active");
            }
            return Ok(());
        }
        self.point_manager
            .lock()
            .unwrap()
            .apply_sync(body.points.clone());
        self.state.apply_synced(body.points.clone());
        Ok(())
    }

    pub fn handle_claim(&self, body: &ClaimBody) -> ClaimResult {
        if !self.config.enabled || body.node_id.is_empty() || body.node_id == self.config.node_id {
            return ClaimResult { accepted: false };
        }
        if self.state.state() == NodeState::Active {
            let (_, _, healthy) = self.data_health();
            let claimant_is_primary = body.role == "primary";
            let self_unhealthy = !healthy;
            if !(claimant_is_primary || self_unhealthy) {
                return ClaimResult { accepted: false };
            }
            self.demote(&format!("claim accepted from node '{}'", body.node_id));
        }
        ClaimResult { accepted: true }
    }

    /// Active 节点应答备机启动/降级后的全量快照拉取。
    pub fn snapshot_for_peer(&self) -> SyncBody {
        let points = if self.is_active() {
            self.point_manager.lock().unwrap().get_all_values()
        } else {
            Vec::new()
        };
        SyncBody {
            node_id: self.state.node_id(),
            config_version: self.state.config_version(),
            points,
        }
    }

    /// 配置变更后由 web 层调用，把配置快照推给对端。
    pub async fn push_config(&self, config_json: serde_json::Value) -> bool {
        if !self.config.enabled || self.state.state() != NodeState::Active {
            return false;
        }
        let url = format!(
            "{}/api/redundancy/config/push",
            self.config.peer_url.trim_end_matches('/')
        );
        let body = ConfigPushBody {
            node_id: self.config.node_id.clone(),
            config: config_json,
        };
        let timeout = Duration::from_millis((self.config.heartbeat_interval_ms * 5).max(2_000));
        match self
            .client
            .post(&url)
            .json(&body)
            .timeout(timeout)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                self.state
                    .record_event("config_synced", "config snapshot pushed to peer");
                true
            }
            _ => {
                log::warn!("Redundancy: config push to peer failed");
                self.state
                    .record_event("error", "config push to peer failed");
                false
            }
        }
    }

    async fn forward_loop(self: Arc<Self>) {
        let mut rx = match self.broadcast_rx.lock().unwrap().take() {
            Some(rx) => rx,
            None => return,
        };
        loop {
            match rx.recv().await {
                Ok(json) => self.forward_data_message(&json).await,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }

    async fn forward_data_message(&self, json: &str) {
        if !self.config.enabled || self.state.state() != NodeState::Active {
            return;
        }
        let Ok(msg) = serde_json::from_str::<WsDataMessage>(json) else {
            return;
        };
        if msg.msg_type != "data" || msg.data.is_empty() {
            return;
        }
        let body = SyncBody {
            node_id: self.config.node_id.clone(),
            config_version: self.state.config_version(),
            points: msg.data,
        };
        self.post_sync(&body).await;
    }

    async fn push_full_snapshot(&self) {
        if !self.config.enabled || self.state.state() != NodeState::Active {
            return;
        }
        let points = self.point_manager.lock().unwrap().get_all_values();
        if points.is_empty() {
            return;
        }
        let body = SyncBody {
            node_id: self.config.node_id.clone(),
            config_version: self.state.config_version(),
            points,
        };
        self.post_sync(&body).await;
    }

    async fn post_sync(&self, body: &SyncBody) {
        let url = format!(
            "{}/api/redundancy/sync",
            self.config.peer_url.trim_end_matches('/')
        );
        let timeout = Duration::from_millis((self.config.heartbeat_interval_ms * 3).max(1_000));
        match self
            .client
            .post(&url)
            .json(body)
            .timeout(timeout)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                self.state.update_sync_pushed(body.points.len());
            }
            _ => log::warn!("Redundancy: value sync push to peer failed"),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::PointManager;
    use crate::types::PointValue;
    use hmi_io_config::{AppConfig, NodeRole};
    use std::sync::{Arc, Mutex};

    fn engine(enabled: bool, role: NodeRole) -> (Arc<RedundancyEngine>, Arc<Mutex<PointManager>>) {
        let mut cfg = RedundancyConfig::default();
        cfg.enabled = enabled;
        cfg.node_id = "node-a".into();
        cfg.role = role;
        cfg.peer_url = "http://127.0.0.1:9".into(); // 不可达端口
        let pm = Arc::new(Mutex::new(PointManager::from_config(
            &AppConfig::default_config(),
        )));
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        let (role_tx, _role_rx) = tokio::sync::mpsc::unbounded_channel::<RoleCommand>();
        let e = RedundancyEngine::new(cfg, pm.clone(), tx.subscribe(), tx);
        e.set_role_tx(role_tx);
        e.set_health_provider(Box::new(|| (1, 1, true))); // 默认健康
        (e, pm)
    }

    #[test]
    fn sync_rejected_when_disabled() {
        let (e, _pm) = engine(false, NodeRole::Primary);
        let body = SyncBody {
            node_id: "node-b".into(),
            config_version: 1,
            points: vec![PointValue::new("mb1:P1", 5.0, "good", 1)],
        };
        assert!(e.handle_sync(&body).is_err());
    }

    #[test]
    fn sync_applies_points_when_standby() {
        let (e, pm) = engine(true, NodeRole::Primary);
        e.state().set_state(NodeState::Standby);
        e.state().set_config_version(5);
        pm.lock()
            .unwrap()
            .insert_test_point("mb1:P1", make_mapping());
        let body = SyncBody {
            node_id: "node-b".into(),
            config_version: 6,
            points: vec![PointValue::new("mb1:P1", 5.0, "good", 1000)],
        };
        e.handle_sync(&body).unwrap();
        let status = e.state().get_status();
        assert_eq!(status.sync.points_received, 1);
        assert_eq!(pm.lock().unwrap().get_all_values().len(), 1);
    }

    #[test]
    fn stale_sync_ignored() {
        let (e, pm) = engine(true, NodeRole::Primary);
        e.state().set_state(NodeState::Standby);
        e.state().set_config_version(9);
        pm.lock()
            .unwrap()
            .insert_test_point("mb1:P1", make_mapping());
        let body = SyncBody {
            node_id: "node-b".into(),
            config_version: 8,
            points: vec![PointValue::new("mb1:P1", 5.0, "good", 1000)],
        };
        e.handle_sync(&body).unwrap();
        assert_eq!(pm.lock().unwrap().get_all_values().len(), 0);
    }

    #[test]
    fn claim_demotes_active_node() {
        let (e, pm) = engine(true, NodeRole::Backup);
        e.state().set_state(NodeState::Active);
        pm.lock().unwrap().set_active(true);
        let res = e.handle_claim(&ClaimBody {
            node_id: "node-b".into(),
            role: "primary".into(),
        });
        assert!(res.accepted);
        assert_eq!(e.state().state(), NodeState::Standby);
        assert!(!pm.lock().unwrap().is_active());
    }

    #[test]
    fn claim_from_self_rejected() {
        let (e, _pm) = engine(true, NodeRole::Primary);
        e.state().set_state(NodeState::Active);
        let res = e.handle_claim(&ClaimBody {
            node_id: "node-a".into(),
            role: "backup".into(),
        });
        assert!(!res.accepted);
        assert_eq!(e.state().state(), NodeState::Active);
    }

    #[test]
    fn claim_rejected_when_active_healthy_and_claimant_backup() {
        let (e, pm) = engine(true, NodeRole::Primary);
        e.state().set_state(NodeState::Active);
        pm.lock().unwrap().set_active(true);
        let res = e.handle_claim(&ClaimBody {
            node_id: "node-b".into(),
            role: "backup".into(),
        });
        assert!(!res.accepted);
        assert_eq!(e.state().state(), NodeState::Active);
    }

    #[test]
    fn claim_accepted_when_active_unhealthy() {
        let (e, pm) = engine(true, NodeRole::Primary);
        e.set_health_provider(Box::new(|| (1, 0, false)));
        e.state().set_state(NodeState::Active);
        pm.lock().unwrap().set_active(true);
        let res = e.handle_claim(&ClaimBody {
            node_id: "node-b".into(),
            role: "backup".into(),
        });
        assert!(res.accepted);
        assert_eq!(e.state().state(), NodeState::Standby);
    }

    #[test]
    fn claim_from_primary_accepted_when_healthy() {
        let (e, pm) = engine(true, NodeRole::Backup);
        e.state().set_state(NodeState::Active);
        pm.lock().unwrap().set_active(true);
        let res = e.handle_claim(&ClaimBody {
            node_id: "node-b".into(),
            role: "primary".into(),
        });
        assert!(res.accepted);
        assert_eq!(e.state().state(), NodeState::Standby);
    }

    fn make_mapping() -> hmi_io_config::PointMapping {
        hmi_io_config::PointMapping {
            id: "P1".into(),
            address: "coil:0".into(),
            data_type: "bool".into(),
            byte_order: "big_endian".into(),
            scale: 1.0,
            offset: 0.0,
            var_type: "DI".into(),
        }
    }
}
