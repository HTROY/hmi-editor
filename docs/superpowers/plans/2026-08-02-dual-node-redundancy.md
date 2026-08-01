# Dual-Node Redundancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为后端增加进程级双机主备冗余（静态角色 + 双通道心跳 + 值/配置同步 + 自动回切），并在 web-ui 提供冗余配置/监控页、HMI 前端支持主备 WS 地址自动切换。

**Architecture:** `hmi-io-point` 新增 `redundancy` 模块：`RedundancyEngine`（心跳/同步/回切状态机）与 `PointManager`（`apply_sync`、`set_active/is_active`）同 crate 协作。Active 节点复用 Bridge 的 broadcast 通道向对端推值，并推送配置快照；Standby 节点不采集、拒绝 WS、收到同步后写入本地缓存与 DB。web-ui 增加 `/redundancy` 与 `/redundancy/monitor` 两页；HMI 前端 `WebSocketClient` 支持主备地址列表。

**Tech Stack:** Rust（tokio / axum / reqwest / serde）、SQLite（rusqlite）、React + Ant Design 5 + ECharts、TypeScript。

---

## 文件结构

新增：

- `io-backend/crates/point/src/redundancy/mod.rs` — 模块导出
- `io-backend/crates/point/src/redundancy/state.rs` — 状态、事件、纯决策函数
- `io-backend/crates/point/src/redundancy/engine.rs` — 心跳/同步/回切引擎
- `io-backend/web-ui/src/pages/RedundancyConfig.tsx` — 冗余配置页
- `io-backend/web-ui/src/pages/RedundancyMonitor.tsx` — 冗余监控页

修改：

- `io-backend/crates/config/src/lib.rs` — `RedundancyConfig`/`NodeRole` + `AppConfig` 字段
- `io-backend/crates/point/Cargo.toml`、`src/lib.rs`、`src/manager.rs`、`src/types.rs`（如需要）
- `io-backend/crates/db/src/repo.rs` — `ConfigSnapshot` 系列 + `apply_config_snapshot`
- `io-backend/crates/plugin/src/registry.rs` — `prepare` / `start_instances` 拆分
- `io-backend/crates/web/src/api.rs`、`server.rs`、`Cargo.toml` — 冗余 API + 配置推送接线
- `io-backend/crates/server/src/ws.rs` — Standby 拒绝 WS、降级断连
- `io-backend/crates/bin/src/main.rs` — 引擎装配与角色命令
- `io-backend/web-ui/src/api/client.ts`、`types.ts`、`App.tsx`
- `src/core/io/types.ts`、`WebSocketClient.ts`、`DataBridge.ts`
- `src/store/editorStore.ts`、`src/editor/panels/ConnectionPanel.tsx`

---

## Task 1: 配置层增加 RedundancyConfig

**Files:**
- Modify: `io-backend/crates/config/src/lib.rs`
- Test: `io-backend/crates/config/src/lib.rs`（同文件 `#[cfg(test)]`）

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/config/src/lib.rs` 的 `mod tests` 中加入：

```rust
#[test]
fn redundancy_config_defaults_disable_redundancy() {
    let cfg = RedundancyConfig::default();
    assert!(!cfg.enabled);
    assert_eq!(cfg.role, NodeRole::Primary);
    assert_eq!(cfg.heartbeat_interval_ms, 1000);
    assert_eq!(cfg.failover_threshold, 3);
    assert_eq!(cfg.failback_delay_ms, 30_000);
    assert_eq!(cfg.full_snapshot_interval_ms, 5_000);
}

#[test]
fn validate_requires_peer_url_when_enabled() {
    let mut cfg = AppConfig::default_config();
    cfg.redundancy.enabled = true;
    cfg.redundancy.node_id = "node-a".into();
    let err = cfg.validate().unwrap_err();
    assert!(err.to_string().contains("peer_url"));
}

#[test]
fn yaml_round_trip_preserves_redundancy() {
    let yaml = r#"
server:
  host: 0.0.0.0
  port: 8080
  path: /iscs/data
plugins:
  directory: ./plugins
  scan_interval_ms: 500
  instances: []
redundancy:
  enabled: true
  node_id: node-a
  role: primary
  peer_url: "http://192.168.1.2:8081"
"#;
    let cfg: AppConfig = serde_yaml::from_str(yaml).unwrap();
    assert!(cfg.redundancy.enabled);
    assert_eq!(cfg.redundancy.node_id, "node-a");
    assert_eq!(cfg.redundancy.role, NodeRole::Primary);
}

#[test]
fn from_repo_sync_reads_redundancy_config() {
    let repo = Repo::new(":memory:").unwrap();
    repo.set_config(
        "redundancy_config",
        r#"{"enabled":true,"node_id":"node-b","role":"backup"}"#,
    )
    .unwrap();
    let cfg = AppConfig::from_repo_sync(&repo);
    assert!(cfg.redundancy.enabled);
    assert_eq!(cfg.redundancy.role, NodeRole::Backup);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-config`（工作目录 `io-backend`）
Expected: 编译失败（`RedundancyConfig` 未定义）。

- [ ] **Step 3: 实现**

在 `io-backend/crates/config/src/lib.rs` 中，`AppConfig` 结构体加字段：

```rust
pub struct AppConfig {
    pub server: ServerConfig,
    pub plugins: PluginsConfig,
    #[serde(default)]
    pub redundancy: RedundancyConfig,
}
```

在 `PluginsConfig` 之后加入：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NodeRole {
    #[default]
    Primary,
    Backup,
}

impl NodeRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeRole::Primary => "primary",
            NodeRole::Backup => "backup",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedundancyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub role: NodeRole,
    #[serde(default)]
    pub peer_url: String,
    #[serde(default = "default_heartbeat_interval_ms")]
    pub heartbeat_interval_ms: u64,
    #[serde(default = "default_failover_threshold")]
    pub failover_threshold: u32,
    #[serde(default = "default_failback_delay_ms")]
    pub failback_delay_ms: u64,
    #[serde(default = "default_full_snapshot_interval_ms")]
    pub full_snapshot_interval_ms: u64,
}

fn default_heartbeat_interval_ms() -> u64 {
    1000
}
fn default_failover_threshold() -> u32 {
    3
}
fn default_failback_delay_ms() -> u64 {
    30_000
}
fn default_full_snapshot_interval_ms() -> u64 {
    5_000
}

impl Default for RedundancyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            node_id: String::new(),
            role: NodeRole::Primary,
            peer_url: String::new(),
            heartbeat_interval_ms: default_heartbeat_interval_ms(),
            failover_threshold: default_failover_threshold(),
            failback_delay_ms: default_failback_delay_ms(),
            full_snapshot_interval_ms: default_full_snapshot_interval_ms(),
        }
    }
}
```

`AppConfig::default_config()` 的返回值加 `redundancy: RedundancyConfig::default(),`。

`validate()` 末尾加：

```rust
if self.redundancy.enabled {
    if self.redundancy.node_id.is_empty() {
        anyhow::bail!("redundancy.node_id is required when redundancy is enabled");
    }
    if self.redundancy.peer_url.is_empty() {
        anyhow::bail!("redundancy.peer_url is required when redundancy is enabled");
    }
    if !self.redundancy.peer_url.starts_with("http://")
        && !self.redundancy.peer_url.starts_with("https://")
    {
        anyhow::bail!("redundancy.peer_url must start with http:// or https://");
    }
}
```

`from_repo_sync` 中读取：

```rust
let redundancy = repo
    .get_config("redundancy_config")
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or_default();
```

并在返回的 `AppConfig` 中加 `redundancy,`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-config`
Expected: 4 个新测试 + 既有测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/config/src/lib.rs
git commit -m "feat(config): add redundancy config block"
```

---

## Task 2: PointManager 增加同步与角色门控接口

**Files:**
- Modify: `io-backend/crates/point/src/manager.rs`

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/point/src/manager.rs` 的 `mod tests` 中加入：

```rust
#[test]
fn apply_sync_writes_known_point_without_rescaling() {
    let config = AppConfig::default_config();
    let mut mgr = PointManager::from_config(&config);
    let mut m = make_mapping("pt5");
    m.scale = 2.0;
    m.offset = 1.0;
    mgr.insert_test_point("pt5", m);
    // Active 节点推送的是已缩放值，Standby 不应二次缩放
    mgr.apply_sync(vec![PointValue::new("pt5", 42.0, "good", 3000)]);
    let vals = mgr.get_all_values();
    assert_eq!(vals.len(), 1);
    assert!((vals[0].numeric_value().unwrap() - 42.0).abs() < 0.01);
    assert_eq!(vals[0].timestamp, 3000);
}

#[test]
fn apply_sync_ignores_unknown_points() {
    let config = AppConfig::default_config();
    let mut mgr = PointManager::from_config(&config);
    mgr.insert_test_point("pt6", make_mapping("pt6"));
    mgr.apply_sync(vec![PointValue::new("ghost", 1.0, "good", 1)]);
    assert_eq!(mgr.count(), 1);
}

#[test]
fn active_flag_gates_role() {
    let mut mgr = PointManager::from_config(&AppConfig::default_config());
    assert!(mgr.is_active());
    mgr.set_active(false);
    assert!(!mgr.is_active());
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-point`
Expected: 编译失败（`apply_sync` / `is_active` 不存在）。

- [ ] **Step 3: 实现**

`PointManager` 增加字段与方法：

```rust
pub struct PointManager {
    points: HashMap<String, CachedPoint>,
    active: bool,
}
```

`from_config` 返回 `Self { points, active: true }`；`insert_test_point` 的构造加 `active` 字段（测试用，值 true）。

新增方法：

```rust
/// 备机接收 Active 推送的已缩放点值，直接写入缓存（不二次缩放/去重）。
pub fn apply_sync(&mut self, points: Vec<PointValue>) {
    for pv in points {
        if let Some(cached) = self.points.get_mut(&pv.id) {
            cached.last_value = Some(pv);
        }
    }
}

/// 设置节点是否处于 Active 角色（Standby 不广播、拒绝写）。
pub fn set_active(&mut self, active: bool) {
    self.active = active;
}

pub fn is_active(&self) -> bool {
    self.active
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-point`
Expected: 新测试 + 既有测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/point/src/manager.rs
git commit -m "feat(point): add apply_sync and role gating to PointManager"
```

---

## Task 3: redundancy 状态类型与决策函数

**Files:**
- Create: `io-backend/crates/point/src/redundancy/mod.rs`
- Create: `io-backend/crates/point/src/redundancy/state.rs`
- Modify: `io-backend/crates/point/src/lib.rs`

- [ ] **Step 1: 写失败测试**

新建 `state.rs`，测试写在文件底部：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PointValue;

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

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
        let status = s.get_status(now());
        assert_eq!(status.events.len(), MAX_EVENTS);
        assert_eq!(status.events[0].message, format!("e{}", MAX_EVENTS + 9));
    }

    #[test]
    fn apply_synced_tracks_latest_values() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        s.apply_synced(vec![PointValue::new("mb1:P1", 1.0, "good", 1000)]);
        s.apply_synced(vec![PointValue::new("mb1:P1", 2.0, "good", 2000)]);
        let status = s.get_status(now());
        assert_eq!(status.synced_points.len(), 1);
        assert!((status.synced_points[0].numeric_value().unwrap() - 2.0).abs() < 0.01);
    }

    #[test]
    fn heartbeat_failure_counts_and_events() {
        let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
        s.record_heartbeat_failure();
        s.record_heartbeat_failure();
        assert_eq!(s.heartbeat_failures(), 2);
        let status = s.get_status(now());
        assert!(status
            .events
            .iter()
            .any(|e| e.kind == "heartbeat_lost"));
        s.record_heartbeat_ok(10, HeartbeatInfo {
            node_id: "node-b".into(),
            role: "backup".into(),
            state: "active".into(),
            config_version: 1,
            uptime_ms: 1000,
        });
        assert_eq!(s.heartbeat_failures(), 0);
        let status = s.get_status(now());
        assert!(status
            .events
            .iter()
            .any(|e| e.kind == "heartbeat_restored"));
    }
}
```

`mod.rs` 先只写 state 导出（引擎类型 Task 4 再加入）：

```rust
mod engine;
mod state;

pub use engine::HeartbeatInfo;
pub use hmi_io_config::NodeRole as Role;
pub use state::{
    decide_initial_state, required_stable_beats, HeartbeatDecision, NodeState, PeerStatus,
    RedundancyEvent, RedundancyState, RedundancyStatus, SyncStats, MAX_EVENTS,
};
```

`lib.rs` 改为：

```rust
pub mod manager;
pub mod redundancy;
pub mod types;

pub use types::point_key;
```

（`engine.rs` 可以先放一个空文件保证编译；Task 4 填实现。）

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-point`
Expected: 编译失败（`state.rs` 中类型未定义）。

- [ ] **Step 3: 实现 state.rs**

```rust
use crate::types::PointValue;
use crate::redundancy::engine::HeartbeatInfo;
use hmi_io_config::NodeRole;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

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
            })),
            started: std::time::Instant::now(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.inner.lock().unwrap().enabled
    }

    pub fn role(&self) -> NodeRole {
        self.inner.lock().unwrap().role
    }

    pub fn node_id(&self) -> String {
        self.inner.lock().unwrap().node_id.clone()
    }

    pub fn state(&self) -> NodeState {
        self.inner.lock().unwrap().state
    }

    pub fn set_state(&self, state: NodeState) {
        let mut inner = self.inner.lock().unwrap();
        inner.state = state;
        if state == NodeState::Active {
            inner.heartbeat_failures = 0;
            inner.stable_heartbeats = 0;
        }
    }

    pub fn config_version(&self) -> u64 {
        self.inner.lock().unwrap().config_version
    }

    pub fn set_config_version(&self, v: u64) {
        self.inner.lock().unwrap().config_version = v;
    }

    pub fn heartbeat_failures(&self) -> u32 {
        self.inner.lock().unwrap().heartbeat_failures
    }

    pub fn record_heartbeat_failure(&self) {
        let mut inner = self.inner.lock().unwrap();
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
        let mut inner = self.inner.lock().unwrap();
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
        self.inner.lock().unwrap().stable_heartbeats
    }

    pub fn reset_stable_heartbeats(&self) {
        self.inner.lock().unwrap().stable_heartbeats = 0;
    }

    pub fn record_peer_seen(&self, rtt_ms: u64) {
        let mut inner = self.inner.lock().unwrap();
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
        let mut inner = self.inner.lock().unwrap();
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
        let mut inner = self.inner.lock().unwrap();
        for pv in points {
            inner.sync.points_received += 1;
            inner.synced_points.insert(pv.id.clone(), pv);
        }
        inner.sync.last_sync_ms = now_ms();
    }

    pub fn update_sync_pushed(&self, count: usize) {
        let mut inner = self.inner.lock().unwrap();
        inner.sync.points_pushed += count as u64;
        inner.sync.last_sync_ms = now_ms();
    }

    pub fn set_split_brain(&self, on: bool) {
        let mut inner = self.inner.lock().unwrap();
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
        let mut inner = self.inner.lock().unwrap();
        inner.events.push_back(RedundancyEvent {
            time_ms: now_ms(),
            kind: kind.to_string(),
            message: message.into(),
        });
        trim(&mut inner.events);
    }

    pub fn increment_failover_count(&self) {
        self.inner.lock().unwrap().failover_count += 1;
    }

    pub fn get_status(&self) -> RedundancyStatus {
        let inner = self.inner.lock().unwrap();
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

```

（注意：`state.rs` 顶部导入中加 `use crate::redundancy::engine::HeartbeatInfo;`——`HeartbeatInfo` 在 engine.rs 定义，Task 4 完善。）

`HeartbeatInfo` 在 engine.rs 定义，因此 Task 3 先建一个包含该结构的 engine.rs（其余类型 Task 4 补齐）：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatInfo {
    pub node_id: String,
    pub role: String,
    pub state: String,
    pub config_version: u64,
    pub uptime_ms: u64,
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-point`
Expected: 新测试 PASS（`decide_initial_state` 等）。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/point/src/lib.rs io-backend/crates/point/src/redundancy
git commit -m "feat(point): add redundancy state types and decision helpers"
```

---

## Task 4: RedundancyEngine（心跳/同步/回切）

**Files:**
- Modify: `io-backend/crates/point/src/redundancy/engine.rs`
- Modify: `io-backend/crates/point/src/redundancy/mod.rs`
- Modify: `io-backend/crates/point/Cargo.toml`

- [ ] **Step 1: 写失败测试**

在 `engine.rs` 底部加测试：

```rust
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
        let pm = Arc::new(Mutex::new(PointManager::from_config(&AppConfig::default_config())));
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        let (role_tx, _role_rx) = tokio::sync::mpsc::unbounded_channel::<RoleCommand>();
        let e = RedundancyEngine::new(cfg, pm.clone(), tx.subscribe(), tx, 8080);
        e.set_role_tx(role_tx);
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
        pm.lock().unwrap().insert_test_point("mb1:P1", make_mapping());
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
        pm.lock().unwrap().insert_test_point("mb1:P1", make_mapping());
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
            node_id: "node-a".into(),
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
        });
        assert!(!res.accepted);
        assert_eq!(e.state().state(), NodeState::Active);
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-point`
Expected: 编译失败（`RedundancyEngine` 不存在）。

- [ ] **Step 3: 实现 engine.rs**

`io-backend/crates/point/Cargo.toml` 增加依赖：

```toml
tokio.workspace = true
anyhow.workspace = true
reqwest = { version = "0.12", default-features = false, features = ["json"] }
```

engine.rs 完整实现：

```rust
use crate::manager::PointManager;
use crate::redundancy::state::{
    decide_initial_state, required_stable_beats, NodeState, RedundancyState,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleCommand {
    Promote,
    Demote,
}

pub struct RedundancyEngine {
    config: RedundancyConfig,
    state: RedundancyState,
    point_manager: Arc<Mutex<PointManager>>,
    broadcast_rx: Mutex<Option<broadcast::Receiver<String>>>,
    broadcast_tx: broadcast::Sender<String>,
    client: reqwest::Client,
    ws_port: u16,
    role_tx: Mutex<Option<mpsc::UnboundedSender<RoleCommand>>>,
    started: Instant,
}

impl RedundancyEngine {
    pub fn new(
        config: RedundancyConfig,
        point_manager: Arc<Mutex<PointManager>>,
        broadcast_rx: broadcast::Receiver<String>,
        broadcast_tx: broadcast::Sender<String>,
        ws_port: u16,
    ) -> Arc<Self> {
        let state = RedundancyState::new(config.enabled, config.node_id.clone(), config.role);
        Arc::new(Self {
            config,
            state,
            point_manager,
            broadcast_rx: Mutex::new(Some(broadcast_rx)),
            broadcast_tx,
            client: reqwest::Client::new(),
            ws_port,
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
        self.point_manager.lock().unwrap().set_active(state == NodeState::Active);
        if state == NodeState::Active {
            self.state.record_event("promoted", "initial state: active");
        } else {
            self.state.record_event("started", "initial state: standby");
        }
    }

    pub async fn run(self: &Arc<Self>) {
        if !self.config.enabled {
            log::info!("Redundancy disabled, engine idle");
            return;
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
                let stale_after = (self.config.heartbeat_interval_ms * 3).max(3_000);
                if now_ms().saturating_sub(last_seen) > stale_after {
                    self.state.mark_peer_stale();
                }
            }
            NodeState::Standby => {
                let start = Instant::now();
                match self.probe_peer().await {
                    Some(hb) => {
                        let rtt = start.elapsed().as_millis() as u64;
                        self.state.record_heartbeat_ok(rtt, hb.clone());
                        if self.config.role == NodeRole::Primary && hb.state == "active" {
                            let beats = required_stable_beats(
                                self.config.failback_delay_ms,
                                self.config.heartbeat_interval_ms,
                            );
                            if self.state.stable_heartbeats() >= beats {
                                self.claim_and_promote().await;
                            }
                        }
                    }
                    None => {
                        self.state.record_heartbeat_failure();
                        let failures = self.state.heartbeat_failures();
                        if failures >= self.config.failover_threshold.max(1)
                            && !self.probe_peer_tcp().await
                        {
                            self.promote();
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
            tokio::net::TcpStream::connect((host, self.ws_port)),
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
        self.state.record_event("promoted", "standby promoted to active");
        self.point_manager.lock().unwrap().set_active(true);
        if let Some(tx) = self.role_tx.lock().unwrap().as_ref() {
            let _ = tx.send(RoleCommand::Promote);
        }
        log::warn!("Redundancy: node '{}' promoted to ACTIVE", self.config.node_id);
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
        log::warn!("Redundancy: node '{}' demoted to STANDBY ({})", self.config.node_id, reason);
    }

    async fn claim_and_promote(&self) {
        let url = format!(
            "{}/api/redundancy/claim",
            self.config.peer_url.trim_end_matches('/')
        );
        let body = ClaimBody {
            node_id: self.config.node_id.clone(),
        };
        let timeout = Duration::from_millis(self.config.heartbeat_interval_ms.max(100));
        match self.client.post(&url).json(&body).timeout(timeout).send().await {
            Ok(r) if r.status().is_success() => match r.json::<ClaimResult>().await {
                Ok(res) if res.accepted => {
                    self.state.record_event("claim", "failback claim accepted by peer");
                    self.promote();
                }
                _ => {
                    self.state.record_event("claim", "failback claim rejected");
                    self.state.reset_stable_heartbeats();
                }
            },
            _ => {
                self.state.record_event("claim", "failback claim failed (peer unreachable)");
                self.state.reset_stable_heartbeats();
            }
        }
    }

    pub fn heartbeat_info(&self) -> HeartbeatInfo {
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
            self.state
                .record_event("split_brain", format!("peer '{}' is also active", body.node_id));
            if self.config.role == NodeRole::Backup {
                self.demote("split-brain resolved: peer is primary and active");
            }
            return Ok(());
        }
        self.point_manager.lock().unwrap().apply_sync(body.points.clone());
        self.state.apply_synced(body.points.clone());
        Ok(())
    }

    pub fn handle_claim(&self, body: &ClaimBody) -> ClaimResult {
        if !self.config.enabled || body.node_id.is_empty() || body.node_id == self.config.node_id {
            return ClaimResult { accepted: false };
        }
        if self.state.state() == NodeState::Active {
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
        match self.client.post(&url).json(&body).timeout(timeout).send().await {
            Ok(r) if r.status().is_success() => {
                self.state.record_event("config_synced", "config snapshot pushed to peer");
                true
            }
            _ => {
                log::warn!("Redundancy: config push to peer failed");
                self.state.record_event("error", "config push to peer failed");
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
        match self.client.post(&url).json(body).timeout(timeout).send().await {
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
```

`mod.rs` 更新为完整导出（Task 3 只导出了 `HeartbeatInfo`）：

```rust
mod engine;
mod state;

pub use engine::{
    ClaimBody, ClaimResult, ConfigPushBody, HeartbeatInfo, RedundancyEngine, RoleCommand, SyncBody,
};
pub use hmi_io_config::NodeRole as Role;
pub use state::{
    decide_initial_state, required_stable_beats, HeartbeatDecision, NodeState, PeerStatus,
    RedundancyEvent, RedundancyState, RedundancyStatus, SyncStats, MAX_EVENTS,
};
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-point`
Expected: 引擎 5 个新测试 PASS；首次构建会拉取 reqwest 依赖（需网络，若沙箱受限请用户授权 `cargo` 网络访问）。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/point/Cargo.toml io-backend/crates/point/src/redundancy
git commit -m "feat(point): add redundancy engine with heartbeat and value sync"
```

---

## Task 5: DB 配置快照与应用

**Files:**
- Modify: `io-backend/crates/db/src/repo.rs`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn apply_config_snapshot_replaces_plugins_and_points() {
    let repo = Repo::new(":memory:").unwrap();
    let pid = repo.insert_plugin("old", "old.wasm", "{}").unwrap();
    repo.insert_point(pid, "P1", "a", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .unwrap();

    let snap = ConfigSnapshot {
        config_version: 7,
        scan_interval_ms: 1000,
        batch_interval_ms: 200,
        plugin_dir: "./plugins".into(),
        redundancy: serde_json::json!({"enabled": true}),
        plugins: vec![SnapshotPlugin {
            name: "new".into(),
            wasm_file: "new.wasm".into(),
            config_json: "{}".into(),
            enabled: true,
            points: vec![SnapshotPoint {
                variable_id: "P2".into(),
                address: "b".into(),
                data_type: "uint16".into(),
                byte_order: "big_endian".into(),
                scale: 1.0,
                offset_val: 0.0,
                var_type: "AI".into(),
                description: String::new(),
            }],
        }],
    };
    repo.apply_config_snapshot(&snap).unwrap();

    let plugins = repo.list_plugins().unwrap();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].name, "new");
    let points = repo.list_points(None).unwrap();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].variable_id, "P2");
    assert_eq!(repo.get_config("config_version").as_deref(), Some("7"));
    assert_eq!(repo.get_config("scan_interval_ms").as_deref(), Some("1000"));
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-db`
Expected: 编译失败（`ConfigSnapshot` 不存在）。

- [ ] **Step 3: 实现**

在 `io-backend/crates/db/src/repo.rs` 顶部（`PluginWithPoints` 之后）加：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub config_version: u64,
    pub scan_interval_ms: u64,
    pub batch_interval_ms: u64,
    pub plugin_dir: String,
    pub redundancy: serde_json::Value,
    pub plugins: Vec<SnapshotPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPlugin {
    pub name: String,
    pub wasm_file: String,
    pub config_json: String,
    pub enabled: bool,
    pub points: Vec<SnapshotPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPoint {
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}
```

`impl Repo` 内加：

```rust
/// 用 Active 节点推送的配置快照整体替换本机插件/点位与关键 server_config。
/// 在单个连接锁内事务执行，保证幂等。
pub fn apply_config_snapshot(&self, snap: &ConfigSnapshot) -> anyhow::Result<()> {
    let mut conn = self.conn.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM points", [])?;
    tx.execute("DELETE FROM plugins", [])?;
    for (key, value) in [
        ("scan_interval_ms", snap.scan_interval_ms.to_string()),
        ("batch_interval_ms", snap.batch_interval_ms.to_string()),
        ("plugin_dir", snap.plugin_dir.clone()),
        ("config_version", snap.config_version.to_string()),
        ("redundancy_config", snap.redundancy.to_string()),
    ] {
        tx.execute(
            "INSERT OR REPLACE INTO server_config(key,value) VALUES(?1,?2)",
            params![key, value],
        )?;
    }
    for pl in &snap.plugins {
        tx.execute(
            "INSERT INTO plugins(name,wasm_file,config_json,enabled) VALUES(?1,?2,?3,?4)",
            params![pl.name, pl.wasm_file, pl.config_json, pl.enabled as i32],
        )?;
        let pid = tx.last_insert_rowid();
        for pt in &pl.points {
            tx.execute(
                "INSERT INTO points(plugin_id,variable_id,address,data_type,byte_order,scale,offset_val,var_type,description)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    pid,
                    pt.variable_id,
                    pt.address,
                    pt.data_type,
                    pt.byte_order,
                    pt.scale,
                    pt.offset_val,
                    pt.var_type,
                    pt.description
                ],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}
```

（`params!` 已由现有 `use rusqlite::{params, Connection};` 提供；`SnapshotPoint` 字段名与 `points` 表列名对应。）

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-db`
Expected: 新测试 PASS，既有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/db/src/repo.rs
git commit -m "feat(db): add config snapshot apply for standby nodes"
```

---

## Task 6: PluginRegistry 拆分 prepare / start_instances

**Files:**
- Modify: `io-backend/crates/plugin/src/registry.rs`

- [ ] **Step 1: 重构实现**

将 `init_from_config` 拆成两步（保留原公开行为）：

```rust
/// 记录插件目录与配置缓存，不启动任何插件（Standby 节点使用）。
pub async fn prepare(&self, config: &AppConfig) -> anyhow::Result<()> {
    {
        let mut pdir = self.plugin_dir.lock().unwrap();
        *pdir = PathBuf::from(&config.plugins.directory);
        if pdir.is_relative() {
            if let Ok(cwd) = std::env::current_dir() {
                *pdir = cwd.join(&*pdir);
            }
        }
        log::info!("Plugin directory: {}", pdir.display());
    }
    *self.config_cache.lock().unwrap() = Some(config.clone());
    Ok(())
}

/// 启动全部已配置插件实例（Active 节点/升主时调用）；已有插件运行则跳过。
pub async fn start_instances(&self, config: &AppConfig) -> anyhow::Result<()> {
    if !self.plugins.lock().unwrap().is_empty() {
        return Ok(());
    }
    for inst in &config.plugins.instances {
        match self
            .load_and_start(inst, config.plugins.scan_interval_ms)
            .await
        {
            Ok(()) => log::info!("Loaded plugin: {}", inst.name),
            Err(e) => log::error!("Failed to load plugin '{}': {}", inst.name, e),
        }
    }
    Ok(())
}

pub fn has_plugins(&self) -> bool {
    !self.plugins.lock().unwrap().is_empty()
}

pub async fn init_from_config(&self, config: &AppConfig) -> anyhow::Result<()> {
    self.prepare(config).await?;
    self.start_instances(config).await
}
```

`init_from_config` 原函数体中的插件目录/缓存逻辑删除，`load_and_start` 与其余代码不动。

- [ ] **Step 2: 验证**

Run: `cargo test -p hmi-io-plugin`
Expected: 既有测试全绿（`resolve_write_target` 等不涉及插件加载）。

- [ ] **Step 3: 提交**

```bash
git add io-backend/crates/plugin/src/registry.rs
git commit -m "feat(plugin): split registry prepare and start for standby nodes"
```

---

## Task 7: web API 冗余端点与配置推送接线

**Files:**
- Modify: `io-backend/crates/web/Cargo.toml`
- Modify: `io-backend/crates/web/src/api.rs`
- Modify: `io-backend/crates/web/src/server.rs`

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/web/src/api.rs` 的 `mod tests` 加：

```rust
#[test]
fn build_config_snapshot_includes_all_fields() {
    let repo = Arc::new(Repo::new(":memory:").unwrap());
    let pid = repo.insert_plugin("mb", "mb.wasm", "{\"host\":\"x\"}").unwrap();
    repo.insert_point(pid, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "d")
        .unwrap();
    repo.set_config("config_version", "3").unwrap();
    repo.set_config("redundancy_config", r#"{"enabled":true}"#).unwrap();

    let snap = build_config_snapshot(&repo);
    assert_eq!(snap.config_version, 3);
    assert_eq!(snap.plugins.len(), 1);
    assert_eq!(snap.plugins[0].name, "mb");
    assert_eq!(snap.plugins[0].points[0].variable_id, "P1");
    assert_eq!(snap.redundancy["enabled"], serde_json::Value::Bool(true));
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-web`
Expected: 编译失败（`build_config_snapshot` 不存在）。

- [ ] **Step 3: 实现 api.rs**

导入新增：

```rust
use hmi_io_config::RedundancyConfig;
use hmi_io_db::repo::{ConfigSnapshot, SnapshotPoint, SnapshotPlugin};
use hmi_io_point::redundancy::{
    ClaimBody, ClaimResult, ConfigPushBody, HeartbeatInfo, RedundancyEngine, RedundancyStatus,
    SyncBody,
};
```

在 `export_config` 之后加入：

```rust
// ============================================================
// Redundancy API
// ============================================================

fn build_config_snapshot(repo: &Repo) -> ConfigSnapshot {
    let scan_ms: u64 = repo
        .get_config("scan_interval_ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let batch_ms: u64 = repo
        .get_config("batch_interval_ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);
    let plugin_dir = repo.get_config("plugin_dir").unwrap_or_else(|| "./plugins".into());
    let version = repo
        .get_config("config_version")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let redundancy = repo
        .get_config("redundancy_config")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    let plugins = repo
        .list_plugins_with_points()
        .unwrap_or_default()
        .into_iter()
        .map(|pw| SnapshotPlugin {
            name: pw.plugin.name,
            wasm_file: pw.plugin.wasm_file,
            config_json: pw.plugin.config_json,
            enabled: pw.plugin.enabled,
            points: pw
                .points
                .into_iter()
                .map(|p| SnapshotPoint {
                    variable_id: p.variable_id,
                    address: p.address,
                    data_type: p.data_type,
                    byte_order: p.byte_order,
                    scale: p.scale,
                    offset_val: p.offset_val,
                    var_type: p.var_type,
                    description: p.description,
                })
                .collect(),
        })
        .collect();
    ConfigSnapshot {
        config_version: version,
        scan_interval_ms: scan_ms,
        batch_interval_ms: batch_ms,
        plugin_dir,
        redundancy,
        plugins,
    }
}

/// 本地配置变更后：递增版本并向对端推送（仅 Active 节点）。
async fn bump_version_and_push(repo: &Repo, engine: &RedundancyEngine) {
    if !engine.is_active() {
        return;
    }
    let v = repo
        .get_config("config_version")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        + 1;
    let _ = repo.set_config("config_version", &v.to_string());
    engine.set_config_version(v);
    let snap = build_config_snapshot(repo);
    let json = serde_json::to_value(&snap).unwrap_or(serde_json::json!({}));
    engine.push_config(json).await;
}

pub async fn get_redundancy_config(
    State(repo): State<AppState>,
) -> Result<Json<RedundancyConfig>, StatusCode> {
    let cfg: RedundancyConfig = repo
        .get_config("redundancy_config")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(Json(cfg))
}

pub async fn update_redundancy_config(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(cfg): Json<RedundancyConfig>,
) -> Result<StatusCode, StatusCode> {
    if cfg.enabled {
        if cfg.node_id.is_empty() || cfg.peer_url.is_empty() {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    let json = serde_json::to_string(&cfg).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    repo.set_config("redundancy_config", &json)
        .map_err(|e| {
            log::error!("{}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    bump_version_and_push(&repo, &engine).await;
    Ok(StatusCode::OK)
}

pub async fn redundancy_heartbeat(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
) -> Json<HeartbeatInfo> {
    engine.record_peer_seen(0);
    Json(engine.heartbeat_info())
}

pub async fn redundancy_sync(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<SyncBody>,
) -> Result<StatusCode, StatusCode> {
    engine.handle_sync(&body).map(|_| StatusCode::OK).map_err(|e| {
        log::warn!("redundancy sync rejected: {}", e);
        StatusCode::CONFLICT
    })
}

pub async fn redundancy_snapshot(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
) -> Json<SyncBody> {
    Json(engine.snapshot_for_peer())
}

pub async fn apply_config_push(
    State(repo): State<AppState>,
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<ConfigPushBody>,
) -> Result<StatusCode, StatusCode> {
    let snap: ConfigSnapshot = serde_json::from_value(body.config).map_err(|e| {
        log::error!("bad config push: {}", e);
        StatusCode::BAD_REQUEST
    })?;
    let local: u64 = repo
        .get_config("config_version")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if snap.config_version < local {
        return Ok(StatusCode::OK); // 旧版本，忽略
    }
    repo.apply_config_snapshot(&snap).map_err(|e| {
        log::error!("apply config snapshot failed: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    engine.set_config_version(snap.config_version);
    engine
        .state()
        .record_event("config_synced", format!("applied config v{}", snap.config_version));
    Ok(StatusCode::OK)
}

pub async fn redundancy_claim(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
    Json(body): Json<ClaimBody>,
) -> Json<ClaimResult> {
    Json(engine.handle_claim(&body))
}

pub async fn redundancy_status(
    Extension(engine): Extension<Arc<RedundancyEngine>>,
) -> Json<RedundancyStatus> {
    Json(engine.state().get_status())
}
```

给每个写操作 handler 加 `Extension(engine): Extension<Arc<RedundancyEngine>>` 参数，并在 DB 写入成功后调用：

```rust
bump_version_and_push(&repo, &engine).await;
```

涉及：`create_plugin`、`update_plugin`、`delete_plugin`、`create_point`、`update_point`、`delete_point`、`import_excel`（`import_excel` 在循环结束后、返回前调用一次）。

`web/Cargo.toml`：把 `hmi-io-config.workspace = true` 从 `[dev-dependencies]` 移到 `[dependencies]`。

`server.rs`：

- `run_web_server` 签名加参数 `redundancy: Arc<RedundancyEngine>`；
- Router 加路由：

```rust
// Redundancy API
.route("/api/redundancy/config", get(super::api::get_redundancy_config).put(super::api::update_redundancy_config))
.route("/api/redundancy/config/push", post(super::api::apply_config_push))
.route("/api/redundancy/heartbeat", get(super::api::redundancy_heartbeat))
.route("/api/redundancy/sync", post(super::api::redundancy_sync))
.route("/api/redundancy/snapshot", get(super::api::redundancy_snapshot))
.route("/api/redundancy/claim", post(super::api::redundancy_claim))
.route("/api/redundancy/status", get(super::api::redundancy_status))
```

`.layer(Extension(redundancy))`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-web`
Expected: 新测试 + 既有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/web/Cargo.toml io-backend/crates/web/src/api.rs io-backend/crates/web/src/server.rs
git commit -m "feat(web): add redundancy API endpoints and config push"
```

---

## Task 8: WS 服务在 Standby 拒绝连接、降级时断开

**Files:**
- Modify: `io-backend/crates/server/src/ws.rs`

- [ ] **Step 1: 实现**

`run_server` 的 accept 循环中，`let (stream, peer) = ...` 之后加：

```rust
// 冗余模式下 Standby 节点拒绝 WS 服务（HMI 前端会尝试下一个地址）
if !point_manager.lock().unwrap().is_active() {
    log::info!("Rejecting WS connection from {}: node is standby", peer);
    continue;
}
```

`handle_connection` 的 `send_h` 任务循环开头（`match bc_rx.recv().await` 之前）无法插入，改为在 `Ok(msg)` 分支最前面加：

```rust
// 降级消息：本机转为 Standby，立即断开所有 WS 客户端
if msg.contains("\"type\":\"role\"") || msg.contains("\"type\": \"role\"") {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
        if v.get("state").and_then(|s| s.as_str()) == Some("standby") {
            log::info!("Node demoted to standby, closing WS client");
            break;
        }
    }
}
```

- [ ] **Step 2: 验证编译**

Run: `cargo check -p hmi-io-server`
Expected: 编译通过。

- [ ] **Step 3: 提交**

```bash
git add io-backend/crates/server/src/ws.rs
git commit -m "feat(server): reject ws clients on standby and close on demote"
```

---

## Task 9: bin 装配冗余引擎

**Files:**
- Modify: `io-backend/crates/bin/src/main.rs`

- [ ] **Step 1: 实现**

导入新增：

```rust
use hmi_io_point::redundancy::{NodeState, RedundancyEngine, RoleCommand};
use tokio::sync::mpsc;
```

将 `registry.init_from_config(&app_config).await?;` 之后、`Bridge::new` 之前的初始化改为：

```rust
let registry = Arc::new(PluginRegistry::new(monitor.clone())?);
let point_manager = Arc::new(Mutex::new(PointManager::from_config(&app_config)));
let point_rx = registry
    .take_point_receiver()
    .ok_or_else(|| anyhow::anyhow!("no point rx"))?;
let (bridge, broadcast_tx) =
    Bridge::new(point_rx, point_manager.clone(), batch_interval_ms);

// 冗余引擎：始终构造（disabled 时引擎空转，行为与单机一致）
let redundancy = RedundancyEngine::new(
    app_config.redundancy.clone(),
    point_manager.clone(),
    broadcast_tx.subscribe(),
    broadcast_tx.clone(),
    ws_port,
);
let (role_tx, mut role_rx) = mpsc::unbounded_channel::<RoleCommand>();
redundancy.set_role_tx(role_tx);

// 初始角色决策：探测对端，Standby 不启动插件
let initial_state = redundancy.decide_initial_state().await;
redundancy.apply_initial_state(initial_state);
registry.prepare(&app_config).await?;
if initial_state == NodeState::Active {
    registry.start_instances(&app_config).await?;
} else {
    log::info!("Node starts as STANDBY, plugins deferred until promotion");
}
```

（删除原 `registry.init_from_config` 调用与 `let registry_arc = Arc::new(registry);`；`registry` 直接以 `Arc` 创建，后续引用全部改用 `registry`。）

在 WebSocket 任务 spawn 之前加引擎与角色任务：

```rust
let engine_task = {
    let r = redundancy.clone();
    tokio::spawn(async move { r.run().await })
};

let repo_for_roles = repo_arc.clone();
let reg_for_roles = registry.clone();
let role_task = tokio::spawn(async move {
    while let Some(cmd) = role_rx.recv().await {
        match cmd {
            RoleCommand::Promote => {
                log::info!("Role command: PROMOTE");
                let cfg = hmi_io_config::AppConfig::from_repo_sync(&repo_for_roles);
                match reg_for_roles.start_instances(&cfg).await {
                    Ok(()) => log::info!("Plugins started after promotion"),
                    Err(e) => log::error!("Failed to start plugins after promotion: {}", e),
                }
            }
            RoleCommand::Demote => {
                log::info!("Role command: DEMOTE");
                reg_for_roles.shutdown();
            }
        }
    }
});
```

`run_web_server(...)` 调用加 `redundancy.clone(),` 参数。`ws_h` 的 `pm_ws` 已传入（`ws.rs` 用它判断 Standby 拒绝）。

`tokio::select!` 中加入 `_ = role_task => {}` 与 `_ = engine_task => {}`（引擎任务常驻，不退出）。

`migrate_yaml_to_db` 中 `set_config("plugin_dir", ...)` 之后加：

```rust
let _ = repo.set_config(
    "redundancy_config",
    &serde_json::to_string(&config.redundancy).unwrap_or_else(|_| "{}".into()),
);
```

`from_repo_sync` 的 `server` 构建中 `batch_interval_ms` 等保持原样；`AppConfig::from_repo_sync` 已带 `redundancy`（Task 1）。

- [ ] **Step 2: 验证编译**

Run: `cargo check`
Expected: 全 workspace 编译通过。

- [ ] **Step 3: 提交**

```bash
git add io-backend/crates/bin/src/main.rs
git commit -m "feat(bin): wire redundancy engine and role commands"
```

---

## Task 10: 后端全量测试

- [ ] **Step 1: 运行全部测试**

Run: `cargo test`（工作目录 `io-backend`）
Expected: 所有 crate 测试 PASS（含既有 30+ 测试）。

- [ ] **Step 2: 手动冒烟（单机模式不受影响）**

Run: `cargo run -- config.yaml`（工作目录 `io-backend`）
Expected: 启动日志出现 `Redundancy disabled, engine idle`，现有插件照常加载，`http://localhost:8081/api/redundancy/status` 返回 `{"enabled":false,...}`。

- [ ] **Step 3: 提交（如需修复）**

如有修复，`git commit -m "fix: ..."`。

---

## Task 11: web-ui API 客户端与类型

**Files:**
- Modify: `io-backend/web-ui/src/api/types.ts`
- Modify: `io-backend/web-ui/src/api/client.ts`

- [ ] **Step 1: 实现 types.ts**

追加：

```ts
export interface RedundancyConfig {
  enabled: boolean;
  node_id: string;
  role: "primary" | "backup";
  peer_url: string;
  heartbeat_interval_ms: number;
  failover_threshold: number;
  failback_delay_ms: number;
  full_snapshot_interval_ms: number;
}

export interface PeerStatus {
  reachable: boolean;
  active: boolean;
  node_id: string;
  config_version: number;
  last_seen_ms: number;
  rtt_ms: number;
  rtt_avg_ms: number;
}

export interface SyncStats {
  last_sync_ms: number;
  points_received: number;
  points_pushed: number;
}

export interface RedundancyEvent {
  time_ms: number;
  kind: string;
  message: string;
}

export interface RedundancyPoint {
  id: string;
  value: string | number | boolean | null;
  quality: string;
  timestamp: number;
}

export interface RedundancyStatus {
  enabled: boolean;
  node_id: string;
  role: string;
  state: string;
  config_version: number;
  uptime_ms: number;
  peer: PeerStatus;
  sync: SyncStats;
  events: RedundancyEvent[];
  rtt_history: number[];
  synced_points: RedundancyPoint[];
  split_brain: boolean;
  failover_count: number;
  heartbeat_failures: number;
}
```

- [ ] **Step 2: 实现 client.ts**

导入类型后追加方法：

```ts
// Redundancy
getRedundancyConfig: () => request<RedundancyConfig>("GET", "/api/redundancy/config"),
saveRedundancyConfig: (c: RedundancyConfig) =>
  request<void>("PUT", "/api/redundancy/config", c),
getRedundancyStatus: () =>
  request<RedundancyStatus>("GET", "/api/redundancy/status"),
```

- [ ] **Step 3: 验证**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: tsc + vite 构建通过。

- [ ] **Step 4: 提交**

```bash
git add io-backend/web-ui/src/api/types.ts io-backend/web-ui/src/api/client.ts
git commit -m "feat(web-ui): add redundancy api client"
```

---

## Task 12: 冗余配置页

**Files:**
- Create: `io-backend/web-ui/src/pages/RedundancyConfig.tsx`

- [ ] **Step 1: 创建页面**

```tsx
import { useEffect, useState } from "react";
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
} from "antd";
import { api } from "../api/client";
import type { RedundancyConfig as RedundancyConfigT } from "../api/types";

interface FormValues {
  enabled: boolean;
  node_id: string;
  role: "primary" | "backup";
  peer_url: string;
  heartbeat_interval_ms: number;
  failover_threshold: number;
  failback_delay_ms: number;
  full_snapshot_interval_ms: number;
}

export default function RedundancyConfig() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.getRedundancyStatus>> | null>(null);
  const [cfg, setCfg] = useState<RedundancyConfigT | null>(null);

  useEffect(() => {
    api.getRedundancyConfig().then((c) => {
      setCfg(c);
      form.setFieldsValue({
        enabled: c.enabled,
        node_id: c.node_id,
        role: c.role,
        peer_url: c.peer_url,
        heartbeat_interval_ms: c.heartbeat_interval_ms,
        failover_threshold: c.failover_threshold,
        failback_delay_ms: c.failback_delay_ms,
        full_snapshot_interval_ms: c.full_snapshot_interval_ms,
      });
    });
    const t = window.setInterval(() => {
      api.getRedundancyStatus().then(setStatus).catch(() => {});
    }, 2000);
    return () => window.clearInterval(t);
  }, [form]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.saveRedundancyConfig(v);
      message.success("冗余配置已保存");
      setCfg(v);
    } catch (e) {
      message.error(`保存失败: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card size="small" title="本机冗余状态">
        <Space wrap size="middle">
          <span>
            节点: <Tag>{status?.node_id ?? "-"}</Tag>
          </span>
          <span>
            角色:{" "}
            <Tag color={status?.role === "primary" ? "blue" : "purple"}>
              {status?.role ?? "-"}
            </Tag>
          </span>
          <span>
            运行态:{" "}
            <Tag
              color={status?.state === "active" ? "green" : "default"}
            >
              {status?.state ?? "-"}
            </Tag>
          </span>
          <span>
            配置版本: <Tag>{status?.config_version ?? "-"}</Tag>
          </span>
          <span>
            对端:{" "}
            <Tag color={status?.peer.reachable ? "green" : "red"}>
              {status?.peer.reachable ? "可达" : "不可达"}
            </Tag>
          </span>
        </Space>
        {status?.split_brain && (
          <Alert
            style={{ marginTop: 10 }}
            type="error"
            showIcon
            message="检测到双主分裂（split-brain），请检查网络并处理"
          />
        )}
        {!status?.enabled && cfg && (
          <Alert
            style={{ marginTop: 10 }}
            type="warning"
            showIcon
            message="冗余未启用，当前为单机模式"
          />
        )}
      </Card>

      <Card size="small" title="冗余配置">
        <Form form={form} layout="vertical" style={{ maxWidth: 720 }}>
          <Form.Item name="enabled" label="启用主备冗余" valuePropName="checked">
            <Switch checkedChildren="开" unCheckedChildren="关" />
          </Form.Item>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item
              name="node_id"
              label="节点 ID"
              style={{ flex: 1 }}
              rules={[{ required: true, message: "请输入节点 ID" }]}
            >
              <Input placeholder="如 node-a" />
            </Form.Item>
            <Form.Item name="role" label="静态角色" style={{ flex: 1 }}>
              <Select
                options={[
                  { value: "primary", label: "主机 primary" },
                  { value: "backup", label: "备机 backup" },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item
            name="peer_url"
            label="对端地址"
            rules={[{ required: true, message: "请输入对端 web 地址" }]}
          >
            <Input placeholder="http://192.168.1.2:8081" />
          </Form.Item>
          <Space style={{ display: "flex" }} size={12} align="start">
            <Form.Item name="heartbeat_interval_ms" label="心跳间隔 (ms)" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={200} step={100} />
            </Form.Item>
            <Form.Item name="failover_threshold" label="失联阈值 (次)" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={1} max={20} />
            </Form.Item>
            <Form.Item name="failback_delay_ms" label="回切稳定期 (ms)" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
            </Form.Item>
          </Space>
          <Form.Item name="full_snapshot_interval_ms" label="全量快照间隔 (ms)">
            <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
          </Form.Item>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: 验证**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: tsc + vite 通过。

- [ ] **Step 3: 提交**

```bash
git add io-backend/web-ui/src/pages/RedundancyConfig.tsx
git commit -m "feat(web-ui): add redundancy config page"
```

---

## Task 13: 冗余监控页

**Files:**
- Create: `io-backend/web-ui/src/pages/RedundancyMonitor.tsx`

- [ ] **Step 1: 创建页面**

```tsx
import { useMemo } from "react";
import {
  ApiOutlined,
  SwapOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, Card, Col, Empty, Row, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { EChartsOption } from "echarts";
import { api } from "../api/client";
import type { RedundancyEvent, RedundancyPoint } from "../api/types";
import StatCard from "../components/StatCard";
import { useEChart } from "../hooks/useEChart";
import { usePolling } from "../hooks/usePolling";
import { formatAge, formatNumber, formatTimeMs, formatUptime } from "../utils/format";

export default function RedundancyMonitor() {
  const status = usePolling(() => api.getRedundancyStatus(), 1000);
  const snap = status.data;

  const chartOption = useMemo<EChartsOption | null>(() => {
    const rtt = snap?.rtt_history ?? [];
    if (rtt.length < 2) return null;
    return {
      animation: false,
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 20, bottom: 24 },
      xAxis: { type: "category", data: rtt.map((_, i) => String(i + 1)), boundaryGap: false },
      yAxis: { type: "value", name: "ms", min: 0 },
      series: [
        {
          name: "心跳 RTT",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: rtt,
          areaStyle: { opacity: 0.12 },
          lineStyle: { width: 2 },
        },
      ],
    };
  }, [snap]);
  const chartRef = useEChart(chartOption);

  const eventColumns: ColumnsType<RedundancyEvent> = [
    {
      title: "时间",
      dataIndex: "time_ms",
      width: 120,
      render: (v: number) => (
        <span className="mono" style={{ fontSize: 11 }}>
          {formatTimeMs(v)}
        </span>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      width: 140,
      render: (v: string) => {
        const color =
          v === "promoted" || v === "demoted"
            ? "orange"
            : v === "split_brain"
              ? "red"
              : v === "config_synced"
                ? "blue"
                : "default";
        return <Tag color={color}>{v}</Tag>;
      },
    },
    {
      title: "说明",
      dataIndex: "message",
      ellipsis: { showTitle: true },
    },
  ];

  const pointColumns: ColumnsType<RedundancyPoint> = [
    { title: "点位 ID", dataIndex: "id", render: (v: string) => <span className="mono">{v}</span> },
    {
      title: "值",
      dataIndex: "value",
      width: 120,
      render: (v: RedundancyPoint["value"]) => (
        <span className="mono" style={{ fontWeight: 600 }}>
          {v === null || v === undefined ? "--" : String(v)}
        </span>
      ),
    },
    {
      title: "质量",
      dataIndex: "quality",
      width: 90,
      render: (v: string) => (
        <Tag color={v === "good" ? "green" : v === "bad" ? "red" : "default"}>{v}</Tag>
      ),
    },
    {
      title: "采样时间",
      dataIndex: "timestamp",
      width: 110,
      render: (v: number) => <span className="mono">{formatTimeMs(v)}</span>,
    },
    {
      title: "同步延迟",
      key: "age",
      width: 100,
      render: (_, pt) => {
        const age = Date.now() - pt.timestamp;
        return (
          <span className="mono" style={{ color: age > 5000 ? "#f59e0b" : "inherit" }}>
            {formatAge(age)}
          </span>
        );
      },
    },
  ];

  const sortedPoints = useMemo(
    () => [...(snap?.synced_points ?? [])].sort((a, b) => a.timestamp - b.timestamp),
    [snap],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {snap?.split_brain && (
        <Alert type="error" showIcon icon={<WarningOutlined />} message="双主分裂告警" description="两个节点均处于 Active，请立即检查网络与节点状态" />
      )}
      {!snap?.enabled && (
        <Alert type="warning" showIcon message="冗余未启用" description="请在“冗余配置”页开启主备冗余" />
      )}

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="本机状态"
            value={snap ? `${snap.role} / ${snap.state}` : "-"}
            icon={<ApiOutlined />}
            color={snap?.state === "active" ? "#22c55e" : "#f59e0b"}
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="对端"
            value={snap ? (snap.peer.reachable ? "可达" : "不可达") : "-"}
            icon={<SwapOutlined />}
            color={snap?.peer.reachable ? "#22c55e" : "#ef4444"}
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="心跳 RTT"
            value={snap ? `${snap.peer.rtt_avg_ms}ms` : "-"}
            icon={<ApiOutlined />}
            color="#3b82f6"
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="值同步延迟"
            value={
              snap && snap.sync.last_sync_ms
                ? formatAge(Date.now() - snap.sync.last_sync_ms)
                : "-"
            }
            icon={<ApiOutlined />}
            color="#06b6d4"
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="切换次数"
            value={snap ? formatNumber(snap.failover_count) : "-"}
            icon={<SwapOutlined />}
            color="#f59e0b"
            loading={status.loading && !snap}
          />
        </Col>
        <Col xs={12} md={6} xl={4}>
          <StatCard
            title="运行时长"
            value={snap ? formatUptime(snap.uptime_ms) : "-"}
            icon={<ApiOutlined />}
            color="#a78bfa"
            loading={status.loading && !snap}
          />
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={10}>
          <Card size="small" title="心跳 RTT 趋势" extra={<Tag color="blue">最近 {snap?.rtt_history.length ?? 0} 次</Tag>}>
            {chartOption ? (
              <div ref={chartRef} style={{ height: 220 }} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无心跳采样" style={{ padding: "40px 0" }} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="冗余事件">
            <Table
              rowKey={(r) => `${r.time_ms}-${r.kind}-${r.message}`}
              size="small"
              columns={eventColumns}
              dataSource={snap?.events ?? []}
              loading={status.loading && !snap}
              pagination={{ pageSize: 8, showSizeChanger: false }}
              locale={{ emptyText: <Empty description="暂无事件" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="同步点位（备机视角）"
        extra={<Tag color="blue">共 {snap?.synced_points.length ?? 0} 点</Tag>}
      >
        <Table
          rowKey="id"
          size="small"
          columns={pointColumns}
          dataSource={sortedPoints}
          loading={status.loading && !snap}
          pagination={{ pageSize: 12, showSizeChanger: false }}
          locale={{ emptyText: <Empty description="暂无同步点位" /> }}
        />
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: 验证**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: tsc + vite 通过。

- [ ] **Step 3: 提交**

```bash
git add io-backend/web-ui/src/pages/RedundancyMonitor.tsx
git commit -m "feat(web-ui): add redundancy monitor page"
```

---

## Task 14: 菜单与路由

**Files:**
- Modify: `io-backend/web-ui/src/App.tsx`

- [ ] **Step 1: 实现**

导入新页面与图标（`ControlOutlined`、`SafetyCertificateOutlined` 任选，此处用 `ControlOutlined`）：

```tsx
import RedundancyConfig from "./pages/RedundancyConfig";
import RedundancyMonitor from "./pages/RedundancyMonitor";
```

`MENU_ITEMS` 追加：

```tsx
{ key: "/redundancy", icon: <ControlOutlined />, label: "冗余配置" },
{ key: "/redundancy/monitor", icon: <RadarChartOutlined />, label: "冗余监控" },
```

`TITLES` 追加：

```tsx
"/redundancy": "冗余配置",
"/redundancy/monitor": "冗余监控",
```

`Routes` 追加：

```tsx
<Route path="/redundancy" element={<RedundancyConfig />} />
<Route path="/redundancy/monitor" element={<RedundancyMonitor />} />
```

- [ ] **Step 2: 验证**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: tsc + vite 通过。

- [ ] **Step 3: 提交**

```bash
git add io-backend/web-ui/src/App.tsx
git commit -m "feat(web-ui): add redundancy menu and routes"
```

---

## Task 15: HMI 前端 WebSocketClient 多地址

**Files:**
- Modify: `src/core/io/types.ts`
- Modify: `src/core/io/WebSocketClient.ts`

- [ ] **Step 1: 实现 types.ts**

```ts
export interface WebSocketConfig extends DataSourceConfig {
  type: "websocket";
  url: string;
  /** 主备地址列表（主在前）；缺省时退回 url */
  urls?: string[];
  protocol: string;
  reconnectInterval: number;
  heartbeatInterval: number;
}
```

- [ ] **Step 2: 实现 WebSocketClient.ts**

构造函数：

```ts
constructor(config: Partial<WebSocketConfig> = {}) {
  const urls = config.urls?.length
    ? config.urls
    : [config.url ?? "ws://localhost:8080/iscs/data"];
  super({
    type: "websocket",
    name: config.name ?? "WebSocket 数据源",
    enabled: config.enabled ?? true,
    url: urls[0],
    urls,
    protocol: config.protocol ?? "",
    reconnectInterval: config.reconnectInterval ?? 5000,
    heartbeatInterval: config.heartbeatInterval ?? 30000,
  } as WebSocketConfig);
  this.urlIndex = 0;
}
```

字段：

```ts
private urlIndex = 0;
```

辅助方法：

```ts
private getUrls(): string[] {
  if (this.config.urls && this.config.urls.length > 0) return this.config.urls;
  return [this.config.url];
}
```

`connect()` 中 `new WebSocket(this.config.url)` 改为 `new WebSocket(this.getUrls()[this.urlIndex] ?? this.config.url)`；`onopen` 日志同步改。

`onclose` 中 `this.scheduleReconnect()` 之前加：

```ts
const urls = this.getUrls();
this.urlIndex = (this.urlIndex + 1) % urls.length;
```

`scheduleReconnect` 改为：

```ts
private scheduleReconnect(): void {
  if (!this.shouldReconnect) return;
  this.clearReconnect();
  // 有多个地址时快速轮询；单个地址维持原重连间隔
  const delay = this.getUrls().length > 1 && this.urlIndex !== 0 ? 100 : this.config.reconnectInterval;
  this.reconnectTimer = setTimeout(() => {
    this.emitStatus("connecting");
    this.connect().catch(() => {});
  }, delay);
}
```

`updateConfig` 中 `Object.assign(this.config, config)` 保持不变（传入 `urls` 即生效；未传 `urls` 时保留旧的）。

- [ ] **Step 3: 验证**

Run: `npm run build`（仓库根目录）
Expected: tsc + vite 通过。

- [ ] **Step 4: 提交**

```bash
git add src/core/io/types.ts src/core/io/WebSocketClient.ts
git commit -m "feat(io): support primary/backup ws urls with failover"
```

---

## Task 16: 编辑器存储与连接面板双地址

**Files:**
- Modify: `src/store/editorStore.ts`
- Modify: `src/core/io/DataBridge.ts`
- Modify: `src/editor/panels/ConnectionPanel.tsx`

- [ ] **Step 1: 实现 editorStore.ts**

类型改为：

```ts
wsConfig: { url: string; backupUrl?: string };
setWsConfig: (c: { url: string; backupUrl?: string }) => void;
```

初始值不变（`{ url: "ws://localhost:8080/iscs/data" }`）。`setWsConfig` 改为：

```ts
setWsConfig: (c) => {
  set({ wsConfig: c });
  const urls = [c.url, ...(c.backupUrl ? [c.backupUrl] : [])];
  get().dataBridge.wsClient.updateConfig({ urls });
},
```

- [ ] **Step 2: 实现 DataBridge.ts**

字段：

```ts
private backupApiBaseUrl: string = "";
```

方法：

```ts
/** Set the backup REST API base URL; falls back when primary is unreachable. */
setBackupApiBaseUrl(url: string): void {
  this.backupApiBaseUrl = url;
}
```

`fetchVariablesFromBackend` 的 `fetch(url)` 改为顺序尝试：

```ts
const fallback = this.backupApiBaseUrl ? `${this.backupApiBaseUrl}/api/points` : null;
let resp: Response | null = null;
try {
  resp = await fetch(url);
  if (!resp.ok && fallback) {
    console.log("[DataBridge] 主 API 不可用，尝试备用:", fallback);
    resp = await fetch(fallback);
  }
} catch (err) {
  if (!fallback) throw err;
  console.log("[DataBridge] 主 API 连接失败，尝试备用:", fallback);
  resp = await fetch(fallback);
}
if (!resp.ok) {
  const text = await resp.text().catch(() => "");
  throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
}
```

（保留原有 `const resp = await fetch(url);` 下方的 `if (!resp.ok)` 检查，替换为上面代码块。）

- [ ] **Step 3: 实现 ConnectionPanel.tsx（IO 后端区块）**

在 `ioBackendApiUrl` 状态之后加：

```tsx
const [ioBackendBackupUrl, setIoBackendBackupUrl] = useState(
  wsConfig?.backupUrl ?? "",
);
const [ioBackendBackupApiUrl, setIoBackendBackupApiUrl] = useState("");
```

`handleSourceChange` 的 `if (source === "io_backend")` 分支改为：

```tsx
if (source === "io_backend") {
  dataBridge?.wsClient.updateConfig({
    urls: [ioBackendUrl, ...(ioBackendBackupUrl ? [ioBackendBackupUrl] : [])],
  });
}
```

`handleConnect` 的 `if (activeSource === "io_backend")` 分支改为：

```tsx
if (activeSource === "io_backend") {
  dataBridge?.wsClient.updateConfig({
    urls: [ioBackendUrl, ...(ioBackendBackupUrl ? [ioBackendBackupUrl] : [])],
  });
  dataBridge?.setBackupApiBaseUrl(ioBackendBackupApiUrl);
  setWsConfig({
    url: ioBackendUrl,
    backupUrl: ioBackendBackupUrl || undefined,
  });
}
```

“IO 后端配置”区块中，在“WebSocket 地址”输入框后加：

```tsx
<div className="prop-group">
  <label>备用 WebSocket 地址（可选）</label>
  <input
    value={ioBackendBackupUrl}
    onChange={(e) => setIoBackendBackupUrl(e.target.value)}
    placeholder="ws://backup-host:8080/iscs/data"
  />
</div>
```

在“REST API 地址”输入框后加：

```tsx
<div className="prop-group">
  <label>备用 REST API 地址（可选）</label>
  <input
    value={ioBackendBackupApiUrl}
    onChange={(e) => setIoBackendBackupApiUrl(e.target.value)}
    placeholder="http://backup-host:8081"
  />
</div>
```

（样式沿用同区块 `.prop-group`/`label`/`input` 现有模式；“websocket”旧数据源区块保持单地址不变。）

- [ ] **Step 4: 验证**

Run: `npm run build`（仓库根目录）
Expected: tsc + vite 通过。

- [ ] **Step 5: 提交**

```bash
git add src/store/editorStore.ts src/core/io/DataBridge.ts src/editor/panels/ConnectionPanel.tsx
git commit -m "feat(editor): configure primary/backup ws and api urls"
```

---

## Task 17: HMI 前端构建验证

- [ ] **Step 1: 全量构建**

Run: `npm run build`（仓库根目录）
Expected: 通过。

- [ ] **Step 2: 提交修复（如有）**

---

## Task 18: 双进程 E2E 验证

**Files:**
- Create: `io-backend/config-node-a.yaml`（临时，验证后可删除）
- Create: `io-backend/config-node-b.yaml`（临时，验证后可删除）

- [ ] **Step 1: 准备两套配置**

`config-node-a.yaml`（主节点，本机 8080/8081）：

```yaml
server:
  host: 0.0.0.0
  port: 8080
  path: /iscs/data
  batch_interval_ms: 100
plugins:
  directory: ./plugins
  scan_interval_ms: 500
  instances:
    - name: modbus_tcp
      wasm_file: modbus_tcp.wasm
      config:
        host: "127.0.0.1"
        port: 502
        slave_id: 1
      points:
        - id: "STA1_211_IA"
          address: "holding_register:0"
          data_type: "uint16"
          scale: 0.1
          var_type: "AI"
redundancy:
  enabled: true
  node_id: node-a
  role: primary
  peer_url: "http://127.0.0.1:9081"
  heartbeat_interval_ms: 1000
  failover_threshold: 3
  failback_delay_ms: 10000
  full_snapshot_interval_ms: 5000
```

`config-node-b.yaml`（备节点，本机 9080/9081，DB 用不同文件）：

```yaml
server:
  host: 0.0.0.0
  port: 9080
  path: /iscs/data
  batch_interval_ms: 100
plugins:
  directory: ./plugins
  scan_interval_ms: 500
  instances:
    - name: modbus_tcp
      wasm_file: modbus_tcp.wasm
      config:
        host: "127.0.0.1"
        port: 502
        slave_id: 1
      points:
        - id: "STA1_211_IA"
          address: "holding_register:0"
          data_type: "uint16"
          scale: 0.1
          var_type: "AI"
redundancy:
  enabled: true
  node_id: node-b
  role: backup
  peer_url: "http://127.0.0.1:8081"
  heartbeat_interval_ms: 1000
  failover_threshold: 3
  failback_delay_ms: 10000
  full_snapshot_interval_ms: 5000
```

- [ ] **Step 2: 启动双进程**

终端 1：`cargo run -- config-node-a.yaml`（工作目录 `io-backend`）
终端 2：`cargo run -- config-node-b.yaml`（工作目录 `io-backend`，需先删除/隔离 `hmi_io.db`，例如临时改环境变量或用不同工作目录复制可执行文件与 `plugins/`）

Expected: A 日志 `Promoted to ACTIVE`/`initial state: active`；B 日志 `initial state: standby`。

- [ ] **Step 3: 验证同步**

`Invoke-RestMethod http://127.0.0.1:8081/api/redundancy/status` → A 为 active、B 为 standby；B 的 `synced_points` 随 A 的 modbus 值更新（需要本机 502 有 modbus 从站或直接观察状态字段）。

- [ ] **Step 4: 验证切换**

终止 A 进程。Expected: B 在约 `3 × 1s` 后日志出现 `promoted to ACTIVE`；B 的 `/api/redundancy/status` 为 active；`ws://127.0.0.1:9080` 可连接。

- [ ] **Step 5: 验证自动回切**

重启 A。Expected: A 先以 standby 进入，约 10s 稳定期后向 B 发起 claim；B 降级并断开 WS 客户端；A 恢复 active。两端 `/api/redundancy/status` 事件表出现 `claim` / `demoted` / `promoted`。

- [ ] **Step 6: 验证配置同步**

在 A 的 web-ui `http://127.0.0.1:8081/redundancy` 修改任一配置并保存 → B 的 `config_version` 跟随递增；A 的 web-ui 中新增插件/点位 → B 的 `/api/points` 出现相同点位。

- [ ] **Step 7: 验证分裂告警（可选）**

用防火墙/断网模拟 A、B 互相不可达 → B 升主；恢复网络后 A 收到 B 的 `/sync` 时记录 `split_brain` 事件并告警，随后 B 因角色为 backup 自动降级。

- [ ] **Step 8: 清理临时配置**

删除 `config-node-a.yaml`、`config-node-b.yaml` 与临时 DB（确认路径后执行；这是手工 E2E 的临时文件，可恢复重建）。

---

## 自审记录

- **Spec 覆盖**：静态角色+双通道心跳（Task 4/9）、值同步备机（Task 4/7/11-13）、配置快照同步（Task 5/7）、自动回切（Task 4）、web-ui 配置/监控页（Task 12/13/14）、HMI 前端双地址（Task 15/16）、错误处理与分裂告警（Task 4/8/13）、E2E（Task 18）。无缺口。
- **类型一致性**：`RedundancyConfig` 字段、`NodeState`/`RoleCommand`、`SyncBody`/`ClaimBody`/`ConfigPushBody`、`ConfigSnapshot` 系列、TS `RedundancyStatus` 与 Rust `get_status()` 输出逐字段对齐；`engine.is_active()` 语义在 Task 4 定义并被 Task 7/9 使用。
- **占位符扫描**：无 TBD/TODO；所有代码步骤均给出完整代码或精确修改点。

---

# Part B：节点级采集健康触发 + 实例级冗余（增量）

> 本部分在 Part A（Task 1–18）基础上追加。执行顺序：Task 19 → Task 30。
> 注意：Part B 各任务推进期间，跨 crate 引用会阶段性编译失败（如 db 新字段先于 web/bin 改造），属预期；每个任务验证只针对其声明的 crate 或构建命令。

## Task 19: DB 插件冗余字段迁移

**Files:**
- Modify: `io-backend/crates/db/src/schema.rs`
- Modify: `io-backend/crates/db/src/repo.rs`

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/db/src/repo.rs` 的 `mod tests` 中加入：

```rust
#[test]
fn plugin_row_round_trips_redundancy_fields() {
    let repo = Repo::new(":memory:").unwrap();
    let pid = repo
        .insert_plugin_full("mb1", "mb.wasm", "{}", "mb-link", "primary", 0)
        .unwrap();
    let p = repo.get_plugin(pid).unwrap().unwrap();
    assert_eq!(p.redundancy_group, "mb-link");
    assert_eq!(p.redundancy_role, "primary");
    assert_eq!(p.priority, 0);
    repo.update_plugin_full(pid, "mb1", "mb.wasm", "{}", "mb-link", "backup", 2, true)
        .unwrap();
    let p = repo.get_plugin(pid).unwrap().unwrap();
    assert_eq!(p.redundancy_role, "backup");
    assert_eq!(p.priority, 2);
}
```

同时把既有 `apply_config_snapshot_replaces_plugins_and_points` 测试中的 `SnapshotPlugin` 增加字段：

```rust
SnapshotPlugin {
    name: "new".into(),
    wasm_file: "new.wasm".into(),
    config_json: "{}".into(),
    enabled: true,
    redundancy_group: "mb-link".into(),
    redundancy_role: "backup".into(),
    priority: 1,
    points: vec![SnapshotPoint {
        variable_id: "P2".into(),
        address: "b".into(),
        data_type: "uint16".into(),
        byte_order: "big_endian".into(),
        scale: 1.0,
        offset_val: 0.0,
        var_type: "AI".into(),
        description: String::new(),
    }],
}
```

并在断言中加 `assert_eq!(plugins[0].redundancy_group, "mb-link");`。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-db`
Expected: 编译失败（`insert_plugin_full` / 字段不存在）。

- [ ] **Step 3: 实现 schema.rs**

在 `init_db` 的 description 迁移之后加：

```rust
// Migration: add instance-redundancy columns if missing
for (col, sql) in [
    (
        "redundancy_group",
        "ALTER TABLE plugins ADD COLUMN redundancy_group TEXT NOT NULL DEFAULT ''",
    ),
    (
        "redundancy_role",
        "ALTER TABLE plugins ADD COLUMN redundancy_role TEXT NOT NULL DEFAULT ''",
    ),
    (
        "priority",
        "ALTER TABLE plugins ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
    ),
] {
    let has: bool = conn
        .prepare(&format!("SELECT 1 FROM pragma_table_info('plugins') WHERE name='{}'", col))?
        .exists([])?;
    if !has {
        log::info!("Migrating: adding {} column to plugins table", col);
        conn.execute_batch(sql)?;
    }
}
```

- [ ] **Step 4: 实现 repo.rs**

`PluginRow` 增加字段：

```rust
pub struct PluginRow {
    pub id: i64,
    pub name: String,
    pub wasm_file: String,
    pub config_json: String,
    pub enabled: bool,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub priority: u32,
}
```

`map_plugin` 改为：

```rust
fn map_plugin(row: &rusqlite::Row) -> rusqlite::Result<PluginRow> {
    Ok(PluginRow {
        id: row.get(0)?,
        name: row.get(1)?,
        wasm_file: row.get(2)?,
        config_json: row.get(3)?,
        enabled: row.get::<_, i32>(4)? != 0,
        redundancy_group: row.get(5)?,
        redundancy_role: row.get(6)?,
        priority: row.get(7)?,
    })
}
```

`list_plugins` / `get_plugin` 的 SELECT 改为：

```sql
SELECT id,name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority FROM plugins ...
```

保留旧 `insert_plugin` / `update_plugin` 签名不变（内部调用新方法、缺省空组），新增：

```rust
pub fn insert_plugin_full(
    &self,
    name: &str,
    wasm_file: &str,
    config_json: &str,
    redundancy_group: &str,
    redundancy_role: &str,
    priority: u32,
) -> anyhow::Result<i64> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO plugins(name,wasm_file,config_json,redundancy_group,redundancy_role,priority)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![name, wasm_file, config_json, redundancy_group, redundancy_role, priority],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn insert_plugin(&self, name: &str, wasm_file: &str, config_json: &str) -> anyhow::Result<i64> {
    self.insert_plugin_full(name, wasm_file, config_json, "", "", 0)
}

pub fn update_plugin_full(
    &self,
    id: i64,
    name: &str,
    wasm_file: &str,
    config_json: &str,
    redundancy_group: &str,
    redundancy_role: &str,
    priority: u32,
    enabled: bool,
) -> anyhow::Result<()> {
    self.conn.lock().unwrap().execute(
        "UPDATE plugins SET name=?2,wasm_file=?3,config_json=?4,redundancy_group=?5,redundancy_role=?6,priority=?7,enabled=?8,updated_at=datetime('now') WHERE id=?1",
        params![id, name, wasm_file, config_json, redundancy_group, redundancy_role, priority, enabled as i32],
    )?;
    Ok(())
}

pub fn update_plugin(
    &self,
    id: i64,
    name: &str,
    wasm_file: &str,
    config_json: &str,
    enabled: bool,
) -> anyhow::Result<()> {
    self.update_plugin_full(id, name, wasm_file, config_json, "", "", 0, enabled)
}
```

`SnapshotPlugin` 增加字段（`redundancy_group`、`redundancy_role`、`priority`），`apply_config_snapshot` 的插件插入语句改为：

```rust
tx.execute(
    "INSERT INTO plugins(name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority)
     VALUES(?1,?2,?3,?4,?5,?6,?7)",
    params![
        pl.name,
        pl.wasm_file,
        pl.config_json,
        pl.enabled as i32,
        pl.redundancy_group,
        pl.redundancy_role,
        pl.priority
    ],
)?;
```

- [ ] **Step 5: 运行确认通过**

Run: `cargo test -p hmi-io-db`
Expected: 新测试 + 既有测试全绿。

- [ ] **Step 6: 提交**

```bash
git add io-backend/crates/db/src/schema.rs io-backend/crates/db/src/repo.rs
git commit -m "feat(db): add plugin redundancy group fields and migration"
```

---

## Task 20: 配置层实例组字段与校验

**Files:**
- Modify: `io-backend/crates/config/src/lib.rs`

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/config/src/lib.rs` 的 `mod tests` 中加入辅助函数与测试：

```rust
fn group_instance(
    name: &str,
    group: &str,
    role: &str,
    priority: u32,
    ids: &[&str],
) -> PluginInstance {
    PluginInstance {
        name: name.into(),
        wasm_file: "p.wasm".into(),
        config: serde_json::json!({}),
        points: ids
            .iter()
            .map(|id| PointMapping {
                id: id.to_string(),
                address: "a".into(),
                data_type: "uint16".into(),
                byte_order: "big_endian".into(),
                scale: 1.0,
                offset: 0.0,
                var_type: "AI".into(),
            })
            .collect(),
        redundancy_group: group.into(),
        redundancy_role: role.into(),
        priority,
    }
}

#[test]
fn redundancy_config_new_defaults() {
    let cfg = RedundancyConfig::default();
    assert_eq!(cfg.plugin_unhealthy_threshold, 3);
    assert_eq!(cfg.plugin_promotion_cooldown_ms, 60_000);
    assert_eq!(cfg.instance_failover_threshold, 3);
    assert!(cfg.instance_failback_enabled);
    assert_eq!(cfg.instance_failback_delay_ms, 30_000);
    assert_eq!(cfg.instance_switch_cooldown_ms, 60_000);
}

#[test]
fn validate_rejects_multiple_primaries_in_group() {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
        group_instance("mb2", "mb-link", "primary", 0, &["P1"]),
    ];
    let err = cfg.validate().unwrap_err();
    assert!(err.to_string().contains("multiple primary"));
}

#[test]
fn validate_rejects_backup_without_priority() {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
        group_instance("mb2", "mb-link", "backup", 0, &["P1"]),
    ];
    assert!(cfg.validate().is_err());
}

#[test]
fn validate_rejects_duplicate_backup_priority() {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
        group_instance("mb2", "mb-link", "backup", 1, &["P1"]),
        group_instance("mb3", "mb-link", "backup", 1, &["P1"]),
    ];
    let err = cfg.validate().unwrap_err();
    assert!(err.to_string().contains("duplicate backup priority"));
}

#[test]
fn validate_rejects_point_set_mismatch() {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        group_instance("mb1", "mb-link", "primary", 0, &["P1", "P2"]),
        group_instance("mb2", "mb-link", "backup", 1, &["P1"]),
    ];
    assert!(cfg.validate().is_err());
}

#[test]
fn validate_accepts_standalone_and_grouped() {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        group_instance("standalone", "", "", 0, &["P1"]),
        group_instance("mb1", "mb-link", "primary", 0, &["P1"]),
        group_instance("mb2", "mb-link", "backup", 1, &["P1"]),
        group_instance("mb3", "mb-link", "backup", 2, &["P1"]),
    ];
    assert!(cfg.validate().is_ok());
}
```

既有 `instance()` 辅助函数补三个字段（`redundancy_group/role/priority` 为空/0）。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-config`
Expected: 编译失败（新字段不存在）。

- [ ] **Step 3: 实现**

`PluginInstance` 增加字段：

```rust
pub struct PluginInstance {
    pub name: String,
    pub wasm_file: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub points: Vec<PointMapping>,
    #[serde(default)]
    pub redundancy_group: String,
    #[serde(default)]
    pub redundancy_role: String,
    #[serde(default)]
    pub priority: u32,
}
```

`RedundancyConfig` 增加字段与默认函数：

```rust
#[serde(default = "default_plugin_unhealthy_threshold")]
pub plugin_unhealthy_threshold: u32,
#[serde(default = "default_plugin_promotion_cooldown_ms")]
pub plugin_promotion_cooldown_ms: u64,
#[serde(default = "default_instance_failover_threshold")]
pub instance_failover_threshold: u32,
#[serde(default = "default_instance_failback_enabled")]
pub instance_failback_enabled: bool,
#[serde(default = "default_instance_failback_delay_ms")]
pub instance_failback_delay_ms: u64,
#[serde(default = "default_instance_switch_cooldown_ms")]
pub instance_switch_cooldown_ms: u64,
```

```rust
fn default_plugin_unhealthy_threshold() -> u32 { 3 }
fn default_plugin_promotion_cooldown_ms() -> u64 { 60_000 }
fn default_instance_failover_threshold() -> u32 { 3 }
fn default_instance_failback_enabled() -> bool { true }
fn default_instance_failback_delay_ms() -> u64 { 30_000 }
fn default_instance_switch_cooldown_ms() -> u64 { 60_000 }
```

`Default` impl 同步补全；`from_repo_sync` 的 `PluginInstance` 构造补：

```rust
redundancy_group: pw.plugin.redundancy_group.clone(),
redundancy_role: pw.plugin.redundancy_role.clone(),
priority: pw.plugin.priority,
```

`validate()` 末尾（节点级校验之后）加实例组校验：

```rust
// ---- 实例级组校验 ----
let mut group_primary: std::collections::HashMap<&str, &PluginInstance> = std::collections::HashMap::new();
let mut group_backups: std::collections::HashMap<&str, Vec<&PluginInstance>> = std::collections::HashMap::new();
for inst in &self.plugins.instances {
    let g = inst.redundancy_group.trim();
    let r = inst.redundancy_role.trim();
    if g.is_empty() && r.is_empty() {
        continue;
    }
    if g.is_empty() || r.is_empty() {
        anyhow::bail!(
            "instance '{}': redundancy_group and redundancy_role must be set together",
            inst.name
        );
    }
    match r {
        "primary" => {
            if inst.priority != 0 {
                anyhow::bail!("instance '{}': primary must not set priority", inst.name);
            }
            if group_primary.insert(g, inst).is_some() {
                anyhow::bail!("group '{}' has multiple primary instances", g);
            }
        }
        "backup" => {
            if inst.priority == 0 {
                anyhow::bail!("instance '{}': backup must set priority >= 1", inst.name);
            }
            group_backups.entry(g).or_default().push(inst);
        }
        _ => anyhow::bail!(
            "instance '{}': redundancy_role must be 'primary' or 'backup'",
            inst.name
        ),
    }
}
for (g, backups) in &group_backups {
    let primary = match group_primary.get(g) {
        Some(p) => *p,
        None => anyhow::bail!("group '{}' has backups but no primary", g),
    };
    let primary_ids: std::collections::HashSet<&str> =
        primary.points.iter().map(|p| p.id.as_str()).collect();
    let mut seen = std::collections::HashSet::new();
    for b in backups {
        if !seen.insert(b.priority) {
            anyhow::bail!("group '{}' has duplicate backup priority {}", g, b.priority);
        }
        let ids: std::collections::HashSet<&str> =
            b.points.iter().map(|p| p.id.as_str()).collect();
        if ids != primary_ids {
            anyhow::bail!(
                "group '{}': backup '{}' point ids must match primary exactly",
                g,
                b.name
            );
        }
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-config`
Expected: 新测试 + 既有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/config/src/lib.rs
git commit -m "feat(config): add instance redundancy groups and validation"
```

---

## Task 21: PointManager 组逻辑映射

**Files:**
- Modify: `io-backend/crates/point/src/manager.rs`

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/point/src/manager.rs` 的 `mod tests` 中加入：

```rust
fn group_config() -> AppConfig {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        PluginInstanceConfig {
            name: "mb1".into(),
            wasm_file: "modbus.wasm".into(),
            config: serde_json::json!({}),
            points: vec![make_mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "primary".into(),
            priority: 0,
        },
        PluginInstanceConfig {
            name: "mb2".into(),
            wasm_file: "modbus.wasm".into(),
            config: serde_json::json!({}),
            points: vec![make_mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 1,
        },
    ];
    cfg
}

#[test]
fn group_active_member_broadcasts_logical_id() {
    let mut mgr = PointManager::from_config(&group_config());
    assert_eq!(mgr.count(), 1); // 组内同名点只算一个逻辑点
    let r = mgr
        .update(PointValue::new(&point_key("mb1", "P1"), 10.0, "good", 1000))
        .unwrap();
    assert_eq!(r.id, "mb-link:P1");
    // 非活跃备成员的值被丢弃
    assert!(mgr
        .update(PointValue::new(&point_key("mb2", "P1"), 99.0, "good", 2000))
        .is_none());
}

#[test]
fn group_switch_keeps_logical_id_stable() {
    let mut mgr = PointManager::from_config(&group_config());
    mgr.update(PointValue::new(&point_key("mb1", "P1"), 10.0, "good", 1000));
    mgr.set_active_instance("mb-link", "mb2");
    let r = mgr
        .update(PointValue::new(&point_key("mb2", "P1"), 20.0, "good", 3000))
        .unwrap();
    assert_eq!(r.id, "mb-link:P1");
    let vals = mgr.get_all_values();
    assert_eq!(vals.len(), 1);
    assert_eq!(vals[0].id, "mb-link:P1");
}
```

既有 `make_mapping` 不变；既有两实例测试构造的 `PluginInstanceConfig` 需补三个新字段（空组/0）。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-point`
Expected: 编译失败（字段/方法不存在）。

- [ ] **Step 3: 实现**

`PointManager` 增加字段：

```rust
pub struct PointManager {
    points: HashMap<String, CachedPoint>,
    active: bool,
    instance_to_logical: HashMap<String, String>,
    active_group_instance: HashMap<String, String>,
}
```

`from_config` 改为：

```rust
pub fn from_config(config: &AppConfig) -> Self {
    let mut points = HashMap::new();
    let mut instance_to_logical = HashMap::new();
    let mut active_group_instance = HashMap::new();
    for inst in &config.plugins.instances {
        let group = inst.redundancy_group.trim();
        let logical_prefix = if group.is_empty() {
            inst.name.clone()
        } else {
            group.to_string()
        };
        for pt in &inst.points {
            let logical_key = point_key(&logical_prefix, &pt.id);
            points.insert(
                logical_key.clone(),
                CachedPoint {
                    mapping: pt.clone(),
                    last_value: None,
                },
            );
            if !group.is_empty() {
                instance_to_logical.insert(point_key(&inst.name, &pt.id), logical_key);
            }
        }
        if !group.is_empty() && inst.redundancy_role == "primary" {
            active_group_instance.insert(group.to_string(), inst.name.clone());
        }
    }
    log::info!("PointManager: {} points configured", points.len());
    Self {
        points,
        active: true,
        instance_to_logical,
        active_group_instance,
    }
}
```

`update` 改为（替换原函数体）：

```rust
pub fn update(&mut self, raw: PointValue) -> Option<PointValue> {
    let id = raw.id.clone();
    // 组点：解析逻辑键并做活跃成员门控
    let logical_id = self
        .instance_to_logical
        .get(&id)
        .cloned()
        .unwrap_or_else(|| id.clone());
    if let Some(logical) = self.instance_to_logical.get(&id) {
        if let Some((group, _)) = logical.split_once(':') {
            if let Some(active_inst) = self.active_group_instance.get(group) {
                if let Some((inst_name, _)) = id.split_once(':') {
                    if inst_name != active_inst {
                        return None; // 非活跃成员数据丢弃
                    }
                }
            }
        }
    }
    let Some(cached) = self.points.get_mut(&logical_id) else {
        return Some(raw);
    };
    let scale = cached.mapping.scale;
    let offset = cached.mapping.offset;
    let mut scaled = apply_scaling(raw, scale, offset);
    scaled.id = logical_id.clone();
    let is_new = cached.last_value.is_none();
    let is_changed = match &cached.last_value {
        Some(prev) => prev.value != scaled.value,
        None => true,
    };
    if is_new || is_changed {
        cached.last_value = Some(scaled.clone());
        Some(scaled)
    } else {
        None
    }
}
```

新增方法：

```rust
/// Registry 实例级切换后同步组的活跃成员。
pub fn set_active_instance(&mut self, group: &str, instance: &str) {
    self.active_group_instance
        .insert(group.to_string(), instance.to_string());
}
```

`insert_test_point` 的构造补 `instance_to_logical: HashMap::new(), active_group_instance: HashMap::new()`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-point`
Expected: 新测试 + 既有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/point/src/manager.rs
git commit -m "feat(point): map instance groups to stable logical ids"
```

---

## Task 22: redundancy 状态增加不健康计数与决策函数

**Files:**
- Modify: `io-backend/crates/point/src/redundancy/state.rs`
- Modify: `io-backend/crates/point/src/redundancy/mod.rs`

- [ ] **Step 1: 写失败测试**

在 `state.rs` 的 `mod tests` 中加入：

```rust
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
fn promotion_records_timestamp() {
    let s = RedundancyState::new(true, "node-a".into(), NodeRole::Primary);
    assert_eq!(s.last_promotion_ms(), 0);
    s.increment_failover_count();
    assert!(s.last_promotion_ms() > 0);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-point`
Expected: 编译失败。

- [ ] **Step 3: 实现**

`RedundancyStateInner` 增加：

```rust
unhealthy_reports: u32,
last_promotion_ms: u64,
```

初始化 0；`set_state` 中同时 `inner.unhealthy_reports = 0;`。

新增纯函数与方法：

```rust
/// 采集不健康触发升主的决策：需达到阈值且冷却期已过。
pub fn should_promote_unhealthy(unhealthy_reports: u32, threshold: u32, cooldown_ok: bool) -> bool {
    cooldown_ok && unhealthy_reports >= threshold.max(1)
}
```

```rust
pub fn record_unhealthy_report(&self) {
    self.inner.lock().unwrap().unhealthy_reports += 1;
}

pub fn reset_unhealthy_reports(&self) {
    self.inner.lock().unwrap().unhealthy_reports = 0;
}

pub fn unhealthy_reports(&self) -> u32 {
    self.inner.lock().unwrap().unhealthy_reports
}

pub fn last_promotion_ms(&self) -> u64 {
    self.inner.lock().unwrap().last_promotion_ms
}
```

`increment_failover_count` 改为同时记录时间：

```rust
pub fn increment_failover_count(&self) {
    let mut inner = self.inner.lock().unwrap();
    inner.failover_count += 1;
    inner.last_promotion_ms = now_ms();
}
```

`RedundancyStatus` 增加 `pub unhealthy_reports: u32,`，`get_status` 填充。

`mod.rs` 导出追加 `should_promote_unhealthy`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-point`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/point/src/redundancy
git commit -m "feat(point): track unhealthy reports and promotion cooldown"
```

---

## Task 23: 引擎采集健康触发与 claim 角色规则

**Files:**
- Modify: `io-backend/crates/point/src/redundancy/engine.rs`

- [ ] **Step 1: 更新测试**

既有测试的 `ClaimBody` 构造补 `role`；`engine()` 辅助函数改为：

```rust
fn engine(enabled: bool, role: NodeRole) -> (Arc<RedundancyEngine>, Arc<Mutex<PointManager>>) {
    let mut cfg = RedundancyConfig::default();
    cfg.enabled = enabled;
    cfg.node_id = "node-a".into();
    cfg.role = role;
    cfg.peer_url = "http://127.0.0.1:9".into();
    let pm = Arc::new(Mutex::new(PointManager::from_config(&AppConfig::default_config())));
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let (role_tx, _role_rx) = tokio::sync::mpsc::unbounded_channel::<RoleCommand>();
    let e = RedundancyEngine::new(cfg, pm.clone(), tx.subscribe(), tx, 8080);
    e.set_role_tx(role_tx);
    e.set_health_provider(Box::new(|| (1, 1, true))); // 默认健康
    (e, pm)
}
```

新增测试：

```rust
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
        node_id: "node-a".into(),
        role: "primary".into(),
    });
    assert!(res.accepted);
    assert_eq!(e.state().state(), NodeState::Standby);
}
```

既有 `claim_demotes_active_node` 中 `ClaimBody` 补 `role: "primary".into()`。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-point`
Expected: 编译失败（`role` 字段、`set_health_provider` 不存在）。

- [ ] **Step 3: 实现**

`HeartbeatInfo` 增加：

```rust
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
```

`ClaimBody` 增加 `pub role: String`。

`RedundancyEngine` 增加字段与方法：

```rust
health_provider: Mutex<Option<Box<dyn Fn() -> (usize, usize, bool) + Send + Sync>>>,
```

`new()` 中初始化 `health_provider: Mutex::new(None)`。

```rust
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
```

`heartbeat_info` 填充三个新字段：

```rust
let (total, connected, healthy) = self.data_health();
HeartbeatInfo {
    node_id: self.state.node_id(),
    role: self.config.role.as_str().to_string(),
    state: /* 不变 */,
    config_version: self.state.config_version(),
    uptime_ms: self.started.elapsed().as_millis() as u64,
    data_healthy: healthy,
    plugins_total: total,
    plugins_connected: connected,
}
```

`on_tick` 的 Standby 分支改为：

```rust
NodeState::Standby => {
    let start = Instant::now();
    match self.probe_peer().await {
        Some(hb) => {
            let rtt = start.elapsed().as_millis() as u64;
            self.state.record_heartbeat_ok(rtt, hb.clone());
            if self.config.role == NodeRole::Primary && hb.state == "active" {
                let beats = required_stable_beats(
                    self.config.failback_delay_ms,
                    self.config.heartbeat_interval_ms,
                );
                if self.state.stable_heartbeats() >= beats {
                    self.claim_and_promote().await;
                }
            } else if !hb.data_healthy {
                // 节点级采集健康触发：对端整机取不到数据
                self.state.record_unhealthy_report();
                let cooldown_ok = now_ms().saturating_sub(self.state.last_promotion_ms())
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
            let failures = self.state.heartbeat_failures();
            if failures >= self.config.failover_threshold.max(1)
                && !self.probe_peer_tcp().await
            {
                self.promote();
            }
        }
    }
}
```

导入追加 `should_promote_unhealthy`。

`claim_and_promote` 的 body 补角色，失败分支重置不健康计数：

```rust
let body = ClaimBody {
    node_id: self.config.node_id.clone(),
    role: self.config.role.as_str().to_string(),
};
```

```rust
_ => {
    self.state.record_event("claim", "failback claim rejected");
    self.state.reset_stable_heartbeats();
    self.state.reset_unhealthy_reports();
}
```

```rust
_ => {
    self.state.record_event("claim", "failback claim failed (peer unreachable)");
    self.state.reset_stable_heartbeats();
    self.state.reset_unhealthy_reports();
}
```

`handle_claim` 改为：

```rust
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-point`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/point/src/redundancy/engine.rs
git commit -m "feat(point): add plugin-health promotion trigger and claim rules"
```

---

## Task 24: Registry 实例组监督器

**Files:**
- Modify: `io-backend/crates/plugin/src/registry.rs`

- [ ] **Step 1: 写失败测试**

在 `io-backend/crates/plugin/src/registry.rs` 的 `mod tests` 中加入：

```rust
#[test]
fn next_member_follows_order_and_wraps() {
    let members = vec![
        MemberRef { name: "p".into(), role: "primary".into(), priority: 0 },
        MemberRef { name: "b1".into(), role: "backup".into(), priority: 1 },
        MemberRef { name: "b2".into(), role: "backup".into(), priority: 2 },
    ];
    assert_eq!(next_member(&members, "p"), Some("b1".to_string()));
    assert_eq!(next_member(&members, "b1"), Some("b2".to_string()));
    assert_eq!(next_member(&members, "b2"), Some("p".to_string()));
}

#[test]
fn rebuild_groups_orders_primary_first_then_priority() {
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        PluginInstanceConfig {
            name: "b2".into(),
            wasm_file: "p.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 2,
        },
        PluginInstanceConfig {
            name: "p".into(),
            wasm_file: "p.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "primary".into(),
            priority: 0,
        },
        PluginInstanceConfig {
            name: "b1".into(),
            wasm_file: "p.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 1,
        },
    ];
    let reg = PluginRegistry::new(MonitorCollector::new()).unwrap();
    reg.rebuild_groups(&cfg);
    let groups = reg.groups.lock().unwrap();
    let g = groups.get("mb-link").unwrap();
    let names: Vec<&str> = g.members.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, vec!["p", "b1", "b2"]);
    assert_eq!(g.active, "p");
}
```

既有 `mapping()` 辅助保持不变；既有 `config_with_two_instances` 的 `PluginInstanceConfig` 构造补三个新字段。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-plugin`
Expected: 编译失败。

- [ ] **Step 3: 实现**

顶部导入与类型：

```rust
use hmi_io_point::manager::PointManager;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct InstanceGroupStatus {
    pub group: String,
    pub members: Vec<InstanceMemberStatus>,
    pub active_instance: String,
    pub consecutive_failures: u32,
    pub last_switch_ms: u64,
    pub last_switch_reason: String,
    pub switch_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceMemberStatus {
    pub name: String,
    pub role: String,
    pub priority: u32,
    pub is_active: bool,
    pub connection_state: i32,
    pub connection_label: String,
}

#[derive(Debug, Clone)]
struct MemberRef {
    name: String,
    role: String,
    priority: u32,
}

#[derive(Debug, Clone)]
struct GroupStateInner {
    group: String,
    members: Vec<MemberRef>,
    active: String,
    failures: u32,
    probe_ticks: u32,
    last_switch_ms: u64,
    last_switch_reason: String,
    switch_count: u64,
}

fn next_member(members: &[MemberRef], active: &str) -> Option<String> {
    let idx = members.iter().position(|m| m.name == active)?;
    Some(members[(idx + 1) % members.len()].name.clone())
}
```

`PluginRegistry` 增加字段：

```rust
groups: Mutex<HashMap<String, GroupStateInner>>,
instance_redundancy: Mutex<hmi_io_config::RedundancyConfig>,
point_manager: Mutex<Option<Arc<Mutex<PointManager>>>>,
```

`new()` 初始化（`instance_redundancy: Mutex::new(Default::default())`，其余空）。

`prepare()` 末尾调用 `self.rebuild_groups(config);` 并保存阈值：

```rust
*self.instance_redundancy.lock().unwrap() = config.redundancy.clone();
```

`rebuild_groups`（`fn rebuild_groups(&self, config: &AppConfig)`）：

```rust
fn rebuild_groups(&self, config: &AppConfig) {
    let mut raw: HashMap<String, Vec<&PluginInstanceConfig>> = HashMap::new();
    for inst in &config.plugins.instances {
        if inst.redundancy_group.is_empty() {
            continue;
        }
        raw.entry(inst.redundancy_group.clone()).or_default().push(inst);
    }
    let mut inner_map = HashMap::new();
    for (group, mut members) in raw {
        members.sort_by_key(|m| match m.redundancy_role.as_str() {
            "primary" => (0, 0),
            _ => (1, m.priority),
        });
        let member_refs: Vec<MemberRef> = members
            .iter()
            .map(|m| MemberRef {
                name: m.name.clone(),
                role: m.redundancy_role.clone(),
                priority: m.priority,
            })
            .collect();
        let active = members
            .iter()
            .find(|m| m.redundancy_role == "primary")
            .map(|m| m.name.clone())
            .unwrap_or_default();
        inner_map.insert(
            group.clone(),
            GroupStateInner {
                group,
                members: member_refs,
                active,
                failures: 0,
                probe_ticks: 0,
                last_switch_ms: 0,
                last_switch_reason: String::new(),
                switch_count: 0,
            },
        );
    }
    *self.groups.lock().unwrap() = inner_map;
}
```

`start_instances` 改为只启动每组活跃成员：

```rust
pub async fn start_instances(&self, config: &AppConfig) -> anyhow::Result<()> {
    if !self.plugins.lock().unwrap().is_empty() {
        return Ok(());
    }
    self.rebuild_groups(config);
    let start_list: Vec<&PluginInstanceConfig> = {
        let groups = self.groups.lock().unwrap();
        config
            .plugins
            .instances
            .iter()
            .filter(|inst| {
                inst.redundancy_group.is_empty()
                    || groups
                        .get(&inst.redundancy_group)
                        .map(|g| g.active == inst.name)
                        .unwrap_or(false)
            })
            .collect()
    };
    for inst in start_list {
        match self.load_and_start(inst, config.plugins.scan_interval_ms).await {
            Ok(()) => log::info!("Loaded plugin: {}", inst.name),
            Err(e) => log::error!("Failed to load plugin '{}': {}", inst.name, e),
        }
    }
    Ok(())
}
```

新增公开方法：

```rust
pub fn set_point_manager(&self, pm: Arc<Mutex<PointManager>>) {
    *self.point_manager.lock().unwrap() = Some(pm);
}

pub fn instance_groups_status(&self) -> Vec<InstanceGroupStatus> {
    let snap = self.monitor.get_snapshot();
    let statuses: HashMap<&str, &hmi_io_monitor::types::PluginStatus> = snap
        .plugins
        .iter()
        .map(|p| (p.name.as_str(), p))
        .collect();
    let groups = self.groups.lock().unwrap();
    let mut out = Vec::new();
    for g in groups.values() {
        let members = g
            .members
            .iter()
            .map(|m| {
                let s = statuses.get(m.name.as_str());
                InstanceMemberStatus {
                    name: m.name.clone(),
                    role: m.role.clone(),
                    priority: m.priority,
                    is_active: m.name == g.active,
                    connection_state: s.map(|p| p.connection_state).unwrap_or(0),
                    connection_label: s
                        .map(|p| p.connection_label.clone())
                        .unwrap_or_else(|| "disconnected".into()),
                }
            })
            .collect();
        out.push(InstanceGroupStatus {
            group: g.group.clone(),
            members,
            active_instance: g.active.clone(),
            consecutive_failures: g.failures,
            last_switch_ms: g.last_switch_ms,
            last_switch_reason: g.last_switch_reason.clone(),
            switch_count: g.switch_count,
        });
    }
    out
}

pub fn spawn_instance_supervisor(
    self: &Arc<Self>,
    scan_interval_ms: u64,
) -> Option<tokio::task::JoinHandle<()>> {
    if self.groups.lock().unwrap().is_empty() {
        return None;
    }
    let this = self.clone();
    Some(tokio::spawn(async move {
        let dur = Duration::from_millis(scan_interval_ms.max(100));
        let mut tick = tokio::time::interval(dur);
        loop {
            tick.tick().await;
            this.supervise_groups(scan_interval_ms).await;
        }
    }))
}
```

私有方法（放在 `resolve_write_target` 之前）：

```rust
async fn supervise_groups(&self, scan_interval_ms: u64) {
    let Some(config) = self.config_cache.lock().unwrap().clone() else {
        return;
    };
    let settings = self.instance_redundancy.lock().unwrap().clone();
    let snap = self.monitor.get_snapshot();
    let statuses: HashMap<&str, &hmi_io_monitor::types::PluginStatus> = snap
        .plugins
        .iter()
        .map(|p| (p.name.as_str(), p))
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let threshold = settings.instance_failover_threshold.max(1);
    let cooldown = settings.instance_switch_cooldown_ms;
    let fresh_window = scan_interval_ms.max(100) * 3;

    // 1) 活跃成员健康检查与切换
    let mut switch_ops: Vec<(String, String, String)> = Vec::new();
    {
        let mut groups = self.groups.lock().unwrap();
        for g in groups.values_mut() {
            let active = g.active.clone();
            let healthy = statuses
                .get(active.as_str())
                .map(|s| {
                    s.connection_state == 2
                        && snap.server_uptime_ms.saturating_sub(s.last_scan_time_ms)
                            < fresh_window
                })
                .unwrap_or(false);
            if healthy {
                g.failures = 0;
                continue;
            }
            g.failures += 1;
            if g.failures < threshold || now.saturating_sub(g.last_switch_ms) < cooldown {
                continue;
            }
            if let Some(next) = next_member(&g.members, &active) {
                if next != active {
                    switch_ops.push((g.group.clone(), next, "active instance unhealthy".into()));
                }
            }
        }
    }
    for (group, next, reason) in switch_ops {
        self.switch_group(&config, &group, &next, &reason, scan_interval_ms)
            .await;
    }

    // 2) 回切探测
    if settings.instance_failback_enabled {
        let failback_interval = settings.instance_failback_delay_ms.max(scan_interval_ms.max(100));
        let mut probe_ops: Vec<(String, String)> = Vec::new();
        {
            let mut groups = self.groups.lock().unwrap();
            for g in groups.values_mut() {
                let Some(primary) = g.members.first().map(|m| m.name.clone()) else {
                    continue;
                };
                if g.active != primary {
                    g.probe_ticks += 1;
                    if g.probe_ticks * scan_interval_ms.max(100) >= failback_interval {
                        g.probe_ticks = 0;
                        probe_ops.push((g.group.clone(), primary));
                    }
                }
            }
        }
        for (group, primary) in probe_ops {
            self.probe_primary_and_takeover(&config, &group, &primary, scan_interval_ms)
                .await;
        }
    }
}

async fn switch_group(
    &self,
    config: &AppConfig,
    group: &str,
    next: &str,
    reason: &str,
    scan_interval_ms: u64,
) {
    let old = { self.groups.lock().unwrap().get(group).map(|g| g.active.clone()) };
    let Some(old) = old else { return };
    if old == next {
        return;
    }
    self.shutdown_instance(&old).await;
    if let Some(inst) = config
        .plugins
        .instances
        .iter()
        .find(|i| i.name == next)
        .cloned()
    {
        match self.load_and_start(&inst, scan_interval_ms).await {
            Ok(()) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                {
                    let mut groups = self.groups.lock().unwrap();
                    if let Some(g) = groups.get_mut(group) {
                        g.active = next.to_string();
                        g.failures = 0;
                        g.last_switch_ms = now;
                        g.last_switch_reason = reason.to_string();
                        g.switch_count += 1;
                    }
                }
                if let Some(pm) = self.point_manager.lock().unwrap().as_ref() {
                    pm.lock().unwrap().set_active_instance(group, next);
                }
                log::warn!(
                    "Instance group '{}': switched {} -> {} ({})",
                    group,
                    old,
                    next,
                    reason
                );
            }
            Err(e) => log::error!(
                "Instance group '{}': failed to start '{}': {}",
                group,
                next,
                e
            ),
        }
    }
}

async fn shutdown_instance(&self, name: &str) {
    let cmd = {
        self.plugins
            .lock()
            .unwrap()
            .get(name)
            .map(|h| h.cmd_tx.clone())
    };
    if let Some(tx) = cmd {
        let _ = tx.send(PluginCommand::Shutdown);
    }
    self.plugins.lock().unwrap().remove(name);
}

async fn probe_primary_and_takeover(
    &self,
    config: &AppConfig,
    group: &str,
    primary: &str,
    scan_interval_ms: u64,
) {
    if self.plugins.lock().unwrap().contains_key(primary) {
        return;
    }
    let Some(inst) = config
        .plugins
        .instances
        .iter()
        .find(|i| i.name == primary)
        .cloned()
    else {
        return;
    };
    if let Err(e) = self.load_and_start(&inst, scan_interval_ms).await {
        log::warn!("Instance group '{}': primary probe failed: {}", group, e);
        return;
    }
    let connected = self
        .monitor
        .get_plugin_status(primary)
        .map(|s| s.connection_state == 2)
        .unwrap_or(false);
    if connected {
        let backup = {
            self.groups
                .lock()
                .unwrap()
                .get(group)
                .map(|g| g.active.clone())
        };
        if let Some(backup) = backup {
            if backup != primary {
                self.shutdown_instance(&backup).await;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                {
                    let mut groups = self.groups.lock().unwrap();
                    if let Some(g) = groups.get_mut(group) {
                        g.active = primary.to_string();
                        g.failures = 0;
                        g.probe_ticks = 0;
                        g.last_switch_ms = now;
                        g.last_switch_reason = "primary recovered".into();
                        g.switch_count += 1;
                    }
                }
                if let Some(pm) = self.point_manager.lock().unwrap().as_ref() {
                    pm.lock().unwrap().set_active_instance(group, primary);
                }
                log::info!("Instance group '{}': failback to '{}'", group, primary);
            }
        }
    } else {
        // 探测失败：立即关闭探测实例，避免与活跃备份双跑
        self.shutdown_instance(primary).await;
        log::warn!("Instance group '{}': primary probe not connected, probe shut down", group);
    }
}
```

`write_point` 的解析改为带组状态：

```rust
pub async fn write_point(&self, point_name: &str, value: f64) -> anyhow::Result<()> {
    let target = {
        let cache = self.config_cache.lock().unwrap();
        let groups = self.groups.lock().unwrap();
        cache
            .as_ref()
            .and_then(|cfg| resolve_write_target(cfg, &groups, point_name))
    };
    // 其余不变
```

`resolve_write_target` 改为：

```rust
fn resolve_write_target(
    config: &AppConfig,
    groups: &HashMap<String, GroupStateInner>,
    point_name: &str,
) -> Option<(String, String)> {
    config.plugins.instances.iter().find_map(|inst| {
        inst.points.iter().find_map(|pt| {
            let logical = if inst.redundancy_group.is_empty() {
                point_key(&inst.name, &pt.id)
            } else {
                point_key(&inst.redundancy_group, &pt.id)
            };
            if logical != point_name {
                return None;
            }
            let target = if inst.redundancy_group.is_empty() {
                inst.name.clone()
            } else {
                groups
                    .get(&inst.redundancy_group)
                    .map(|g| g.active.clone())
                    .unwrap_or_else(|| inst.name.clone())
            };
            Some((target, pt.id.clone()))
        })
    })
}
```

既有 `resolve_write_target` 测试调用处改为传 `&HashMap::new()`；新增组路由测试：

```rust
#[test]
fn resolve_write_target_routes_to_active_group_member() {
    let mut cfg = config_with_two_instances();
    cfg.plugins.instances[1].redundancy_group = "mb-link".into();
    cfg.plugins.instances[1].redundancy_role = "primary".into();
    cfg.plugins.instances.push(PluginInstanceConfig {
        name: "mb1b".into(),
        wasm_file: "modbus.wasm".into(),
        config: serde_json::json!({}),
        points: vec![mapping("P1")],
        redundancy_group: "mb-link".into(),
        redundancy_role: "backup".into(),
        priority: 1,
    });
    let mut groups = HashMap::new();
    groups.insert(
        "mb-link".into(),
        GroupStateInner {
            group: "mb-link".into(),
            members: vec![
                MemberRef { name: "mb2".into(), role: "primary".into(), priority: 0 },
                MemberRef { name: "mb1b".into(), role: "backup".into(), priority: 1 },
            ],
            active: "mb2".into(),
            failures: 0,
            probe_ticks: 0,
            last_switch_ms: 0,
            last_switch_reason: String::new(),
            switch_count: 0,
        },
    );
    assert_eq!(
        resolve_write_target(&cfg, &groups, "mb-link:P1"),
        Some(("mb2".to_string(), "P1".to_string()))
    );
}
```

注意：`config_with_two_instances` 中 mb1 未配组，`mb1:P1` 仍按原逻辑路由。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-plugin`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/plugin/src/registry.rs
git commit -m "feat(plugin): add per-instance group supervisor with failover"
```

---

## Task 25: web API 增量（插件字段、include_backup、实例组端点）

**Files:**
- Modify: `io-backend/crates/web/src/api.rs`
- Modify: `io-backend/crates/web/src/server.rs`

- [ ] **Step 1: 更新测试并新增**

既有 `list_points` 测试的 `PluginQuery` 构造补 `include_backup: None`。新增：

```rust
#[tokio::test]
async fn list_points_uses_group_logical_id_and_hides_backups() {
    let repo = Arc::new(Repo::new(":memory:").unwrap());
    let p1 = repo
        .insert_plugin_full("mb1", "mb.wasm", "{}", "mb-link", "primary", 0)
        .unwrap();
    let p2 = repo
        .insert_plugin_full("mb2", "mb.wasm", "{}", "mb-link", "backup", 1)
        .unwrap();
    repo.insert_point(p1, "P1", "a", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .unwrap();
    repo.insert_point(p2, "P1", "b", "bool", "big_endian", 1.0, 0.0, "DI", "")
        .unwrap();

    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = vec![
        PluginInstance {
            name: "mb1".into(),
            wasm_file: "mb.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "primary".into(),
            priority: 0,
        },
        PluginInstance {
            name: "mb2".into(),
            wasm_file: "mb.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
            redundancy_group: "mb-link".into(),
            redundancy_role: "backup".into(),
            priority: 1,
        },
    ];
    let pm = Arc::new(Mutex::new(PointManager::from_config(&cfg)));

    let res = list_points(
        State(repo.clone()),
        Extension(pm.clone()),
        Query(PluginQuery { plugin_id: None, include_backup: None }),
    )
    .await
    .unwrap();
    assert_eq!(res.0.len(), 1);
    assert_eq!(res.0[0].hmi_id, "mb-link:P1");

    let res = list_points(
        State(repo),
        Extension(pm),
        Query(PluginQuery { plugin_id: None, include_backup: Some(true) }),
    )
    .await
    .unwrap();
    assert_eq!(res.0.len(), 2);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p hmi-io-web`
Expected: 编译失败。

- [ ] **Step 3: 实现 api.rs**

`UpsertPlugin` 增加：

```rust
#[serde(default)]
pub redundancy_group: String,
#[serde(default)]
pub redundancy_role: String,
#[serde(default)]
pub priority: u32,
```

`create_plugin` 改为调用 `repo.insert_plugin_full(&p.name, &p.wasm_file, &p.config_json, &p.redundancy_group, &p.redundancy_role, p.priority)`；`update_plugin` 改为 `repo.update_plugin_full(id, ..., p.redundancy_group, p.redundancy_role, p.priority, p.enabled)`。写入前调用校验：

```rust
fn validate_group_edit(repo: &Repo, candidate: &UpsertPlugin, edit_id: Option<i64>) -> Result<(), StatusCode> {
    let mut plugins = repo.list_plugins().map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    if let Some(id) = edit_id {
        plugins.retain(|p| p.id != id);
    }
    plugins.push(PluginRow {
        id: edit_id.unwrap_or(0),
        name: candidate.name.clone(),
        wasm_file: candidate.wasm_file.clone(),
        config_json: candidate.config_json.clone(),
        enabled: candidate.enabled,
        redundancy_group: candidate.redundancy_group.clone(),
        redundancy_role: candidate.redundancy_role.clone(),
        priority: candidate.priority,
    });
    let instances: Vec<PluginInstance> = plugins
        .into_iter()
        .map(|p| {
            let points = repo
                .list_points(Some(p.id))
                .unwrap_or_default()
                .into_iter()
                .map(|pt| PointMapping {
                    id: pt.variable_id,
                    address: pt.address,
                    data_type: pt.data_type,
                    byte_order: pt.byte_order,
                    scale: pt.scale,
                    offset: pt.offset_val,
                    var_type: pt.var_type,
                })
                .collect();
            PluginInstance {
                name: p.name,
                wasm_file: p.wasm_file,
                config: serde_json::from_str(&p.config_json).unwrap_or(serde_json::json!({})),
                points,
                redundancy_group: p.redundancy_group,
                redundancy_role: p.redundancy_role,
                priority: p.priority,
            }
        })
        .collect();
    let mut cfg = AppConfig::default_config();
    cfg.plugins.instances = instances;
    cfg.validate().map_err(|e| {
        log::warn!("group validation failed: {}", e);
        StatusCode::BAD_REQUEST
    })
}
```

`PluginQuery` 增加 `pub include_backup: Option<bool>`；`list_points` 过滤与 `hmi_id` 改为：

```rust
fn hmi_id_for_point(p: &PointRow) -> String {
    if p.redundancy_group.is_empty() {
        point_key(&p.plugin_name, &p.variable_id)
    } else {
        point_key(&p.redundancy_group, &p.variable_id)
    }
}
```

```rust
let include_backup = q.include_backup.unwrap_or(false);
let pm = point_manager.lock().unwrap();
let filtered: Vec<PointView> = all_points
    .into_iter()
    .filter(|p| {
        if !include_backup && p.redundancy_role == "backup" {
            return false;
        }
        pm.has_point(&hmi_id_for_point(p))
    })
    .map(PointView::from)
    .collect();
```

`PointView` 增加 `redundancy_group`、`plugin_role` 字段并在 `From<PointRow>` 填充（`row.redundancy_group.clone()` / `row.redundancy_role.clone()`）。

`build_config_snapshot` 的 `SnapshotPlugin` 构造补：

```rust
redundancy_group: pw.plugin.redundancy_group.clone(),
redundancy_role: pw.plugin.redundancy_role.clone(),
priority: pw.plugin.priority,
```

新增端点 handler：

```rust
pub async fn redundancy_instance_groups(
    Extension(registry): Extension<Arc<hmi_io_plugin::registry::PluginRegistry>>,
) -> Json<Vec<hmi_io_plugin::registry::InstanceGroupStatus>> {
    Json(registry.instance_groups_status())
}
```

`server.rs`：`run_web_server` 参数 `_registry` 改名 `registry`；路由加：

```rust
.route("/api/redundancy/instance-groups", get(super::api::redundancy_instance_groups))
```

`web` crate 依赖补 `hmi-io-config`（已在 Task 7 移入 dependencies）。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p hmi-io-web`
Expected: 新测试 + 既有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add io-backend/crates/web/src/api.rs io-backend/crates/web/src/server.rs
git commit -m "feat(web): plugin group fields, include_backup points, instance-groups api"
```

---

## Task 26: bin 接线（健康提供者、实例监督器、迁移）

**Files:**
- Modify: `io-backend/crates/bin/src/main.rs`

- [ ] **Step 1: 实现**

`prepare` 之后（`start_instances` 前后均可）加：

```rust
registry.set_point_manager(point_manager.clone());

redundancy.set_health_provider(Box::new({
    let mon = monitor.clone();
    let scan = app_config.plugins.scan_interval_ms.max(100);
    move || {
        let snap = mon.get_snapshot();
        let total = snap.plugins.len();
        let connected = snap
            .plugins
            .iter()
            .filter(|p| p.connection_state == 2)
            .count();
        let fresh = snap.plugins.iter().any(|p| {
            p.connection_state == 2
                && snap.server_uptime_ms.saturating_sub(p.last_scan_time_ms) < scan * 3
        });
        (total, connected, fresh)
    }
}));

if let Some(h) = registry.spawn_instance_supervisor(app_config.plugins.scan_interval_ms) {
    let _ = h;
}
```

`migrate_yaml_to_db` 的 `insert_plugin` 调用改为：

```rust
match repo.insert_plugin_full(
    &inst.name,
    &inst.wasm_file,
    &cj,
    &inst.redundancy_group,
    &inst.redundancy_role,
    inst.priority,
) {
    Ok(pid) => { /* 原逻辑不变 */ }
    Err(e) => log::warn!("  Skip '{}': {}", inst.name, e),
}
```

- [ ] **Step 2: 验证编译**

Run: `cargo check`
Expected: 全 workspace 编译通过。

- [ ] **Step 3: 提交**

```bash
git add io-backend/crates/bin/src/main.rs
git commit -m "feat(bin): wire health provider and instance supervisor"
```

---

## Task 27: web-ui 类型/客户端与插件、点位页

**Files:**
- Modify: `io-backend/web-ui/src/api/types.ts`
- Modify: `io-backend/web-ui/src/api/client.ts`
- Modify: `io-backend/web-ui/src/pages/Plugins.tsx`
- Modify: `io-backend/web-ui/src/pages/Points.tsx`

- [ ] **Step 1: 实现 types.ts**

`PluginRow` 增加：

```ts
redundancy_group: string;
redundancy_role: string;
priority: number;
```

`PointRow` 增加 `redundancy_group: string; plugin_role: string;`（对应 PointView）。

`RedundancyConfig` 增加：

```ts
plugin_unhealthy_threshold: number;
plugin_promotion_cooldown_ms: number;
instance_failover_threshold: number;
instance_failback_enabled: boolean;
instance_failback_delay_ms: number;
instance_switch_cooldown_ms: number;
```

新增：

```ts
export interface InstanceMemberStatus {
  name: string;
  role: string;
  priority: number;
  is_active: boolean;
  connection_state: number;
  connection_label: string;
}

export interface InstanceGroupStatus {
  group: string;
  members: InstanceMemberStatus[];
  active_instance: string;
  consecutive_failures: number;
  last_switch_ms: number;
  last_switch_reason: string;
  switch_count: number;
}
```

- [ ] **Step 2: 实现 client.ts**

`listPoints` 改为：

```ts
listPoints: (pluginId: number, includeBackup = false) =>
  request<PointRow[]>(
    "GET",
    `/api/points?plugin_id=${pluginId}&include_backup=${includeBackup}`,
  ),
```

`createPlugin`/`updatePlugin` 的 payload 增加 `redundancy_group/redundancy_role/priority`。新增：

```ts
getInstanceGroups: () =>
  request<InstanceGroupStatus[]>("GET", "/api/redundancy/instance-groups"),
```

- [ ] **Step 3: 实现 Plugins.tsx**

`PluginFormValues` 增加 `redundancy_group: string; redundancy_role: string; priority: number;`。

表格列追加：

```tsx
{
  title: "冗余组",
  dataIndex: "redundancy_group",
  width: 110,
  render: (v: string) => (v ? <Tag color="blue">{v}</Tag> : <span style={{ opacity: 0.35 }}>-</span>),
},
{
  title: "角色",
  dataIndex: "redundancy_role",
  width: 100,
  render: (v: string) =>
    v === "primary" ? <Tag color="green">主</Tag> : v === "backup" ? <Tag color="orange">备</Tag> : <span style={{ opacity: 0.35 }}>-</span>,
},
{
  title: "优先级",
  dataIndex: "priority",
  width: 80,
  render: (v: number) => (v > 0 ? <span className="mono">{v}</span> : <span style={{ opacity: 0.35 }}>-</span>),
},
```

表单追加（保存时并入 payload）：

```tsx
<Form.Item name="redundancy_group" label="冗余组（可选）">
  <Input placeholder="如 mb-link" />
</Form.Item>
<Form.Item name="redundancy_role" label="组内角色">
  <Select
    options={[
      { value: "", label: "无" },
      { value: "primary", label: "主 primary" },
      { value: "backup", label: "备 backup" },
    ]}
  />
</Form.Item>
<Form.Item noStyle shouldUpdate>
  {({ getFieldValue }) =>
    getFieldValue("redundancy_role") === "backup" ? (
      <Form.Item name="priority" label="切换优先级（越小越先）" rules={[{ required: true, message: "请输入优先级" }]}>
        <InputNumber min={1} style={{ width: "100%" }} />
      </Form.Item>
    ) : null
  }
</Form.Item>
```

`openCreate`/`openEdit` 的 `setFieldsValue` 同步补三个字段。

- [ ] **Step 4: 实现 Points.tsx**

`loadPoints` 调用改为 `api.listPoints(pid, includeBackup)`；新增 `const [includeBackup, setIncludeBackup] = useState(false);`，工具栏加 `Switch checkedChildren="含备实例" unCheckedChildren="仅主实例" onChange={setIncludeBackup}`，并在 `useEffect` 依赖中加入 `includeBackup`。表格加“角色”列（`plugin_role` 与 `redundancy_group` 标签）。

- [ ] **Step 5: 验证**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: tsc + vite 通过。

- [ ] **Step 6: 提交**

```bash
git add io-backend/web-ui/src/api/types.ts io-backend/web-ui/src/api/client.ts io-backend/web-ui/src/pages/Plugins.tsx io-backend/web-ui/src/pages/Points.tsx
git commit -m "feat(web-ui): plugin group fields and backup point views"
```

---

## Task 28: web-ui 冗余配置/监控页增量

**Files:**
- Modify: `io-backend/web-ui/src/pages/RedundancyConfig.tsx`
- Modify: `io-backend/web-ui/src/pages/RedundancyMonitor.tsx`

- [ ] **Step 1: 实现 RedundancyConfig.tsx**

`FormValues` 与表单各增加六个字段：

```tsx
<Form.Item name="plugin_unhealthy_threshold" label="采集不健康升主阈值（次）">
  <InputNumber style={{ width: "100%" }} min={1} max={20} />
</Form.Item>
<Form.Item name="plugin_promotion_cooldown_ms" label="健康触发升主冷却 (ms)">
  <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
</Form.Item>
<Form.Item name="instance_failover_threshold" label="实例切换阈值（连续失败）">
  <InputNumber style={{ width: "100%" }} min={1} max={20} />
</Form.Item>
<Form.Item name="instance_failback_enabled" label="实例自动回切" valuePropName="checked">
  <Switch checkedChildren="开" unCheckedChildren="关" />
</Form.Item>
<Form.Item name="instance_failback_delay_ms" label="实例回切探测间隔 (ms)">
  <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
</Form.Item>
<Form.Item name="instance_switch_cooldown_ms" label="实例切换冷却 (ms)">
  <InputNumber style={{ width: "100%" }} min={1000} step={1000} />
</Form.Item>
```

`useEffect` 的 `setFieldsValue` 同步补全。

- [ ] **Step 2: 实现 RedundancyMonitor.tsx**

新增轮询与表格：

```tsx
const groups = usePolling(() => api.getInstanceGroups(), 1000);
```

在“同步点位”卡片之前加：

```tsx
<Card
  size="small"
  title="实例冗余组"
  extra={<Tag color="blue">{groups.data?.length ?? 0} 组</Tag>}
>
  <Table
    rowKey="group"
    size="small"
    columns={groupColumns}
    dataSource={groups.data ?? []}
    loading={groups.loading && !groups.data}
    pagination={false}
    locale={{ emptyText: <Empty description="未配置实例冗余组" /> }}
  />
</Card>
```

列定义（展开成员，用 `render` 渲染组内成员标签）：

```tsx
const groupColumns: ColumnsType<InstanceGroupStatus> = [
  { title: "组名", dataIndex: "group", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
  {
    title: "成员",
    dataIndex: "members",
    render: (members: InstanceMemberStatus[]) => (
      <Space size={4} wrap>
        {members.map((m) => (
          <Tag key={m.name} color={m.is_active ? "green" : m.role === "primary" ? "blue" : "default"}>
            {m.name}（{m.role === "primary" ? "主" : `备${m.priority}`}）
            {m.is_active ? " ●" : ""}
          </Tag>
        ))}
      </Space>
    ),
  },
  { title: "活跃实例", dataIndex: "active_instance", width: 140, render: (v: string) => <span className="mono">{v}</span> },
  { title: "连续失败", dataIndex: "consecutive_failures", width: 90, render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : <span>{v}</span>) },
  { title: "切换次数", dataIndex: "switch_count", width: 90 },
  { title: "上次切换", dataIndex: "last_switch_reason", ellipsis: { showTitle: true } },
];
```

`api/types.ts` 已含 `InstanceGroupStatus`（Task 27）。

- [ ] **Step 3: 验证**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: tsc + vite 通过。

- [ ] **Step 4: 提交**

```bash
git add io-backend/web-ui/src/pages/RedundancyConfig.tsx io-backend/web-ui/src/pages/RedundancyMonitor.tsx
git commit -m "feat(web-ui): redundancy config thresholds and instance group monitor"
```

---

## Task 29: 全量构建验证

- [ ] **Step 1: 后端测试**

Run: `cargo test`（工作目录 `io-backend`）
Expected: 全部 PASS。

- [ ] **Step 2: web-ui 构建**

Run: `npm run build`（工作目录 `io-backend/web-ui`）
Expected: 通过。

- [ ] **Step 3: HMI 前端构建**

Run: `npm run build`（仓库根目录）
Expected: 通过。

- [ ] **Step 4: 提交修复（如有）**

---

## Task 30: E2E 补充（实例级 + 节点级健康触发）

- [ ] **Step 1: 单机实例级切换**

准备 `config-instance.yaml`（`redundancy.enabled: false`）：

```yaml
server: { host: 0.0.0.0, port: 8080, path: /iscs/data, batch_interval_ms: 100 }
plugins:
  directory: ./plugins
  scan_interval_ms: 500
  instances:
    - name: iec104
      redundancy_group: dual-link
      redundancy_role: primary
      wasm_file: iec104.wasm
      config: { host: "127.0.0.1", port: 2404, common_address: 1 }
      points:
        - { id: "STA1_211_IA", address: "1003", data_type: "float32", var_type: "AI" }
        - { id: "STA1_BUS_VOLTAGE", address: "1005", data_type: "float32", var_type: "AI" }
    - name: opc_ua_backup
      redundancy_group: dual-link
      redundancy_role: backup
      priority: 1
      wasm_file: opc_ua.wasm
      config: { endpoint: "opc.tcp://127.0.0.1:4840" }
      points:
        - { id: "STA1_211_IA", address: "ns=2;s=Temperature.Zone1", var_type: "AI" }
        - { id: "STA1_BUS_VOLTAGE", address: "ns=2;s=Temperature.Zone2", var_type: "AI" }
redundancy:
  enabled: false
  instance_failover_threshold: 3
  instance_failback_enabled: true
  instance_failback_delay_ms: 10000
  instance_switch_cooldown_ms: 5000
```

启动两个测试服务（`cargo run -p iec104-slave`、`cargo run -p opcua-server`）与后端 `cargo run -- config-instance.yaml`。

Expected：
- 初始 `GET /api/redundancy/instance-groups`：活跃 = `iec104`，HMI 变量 `dual-link:STA1_211_IA` 有值；
- 停止 iec104-slave → 约 3 次扫描后切到 `opc_ua_backup`，变量 ID 仍为 `dual-link:STA1_211_IA`，值来自 OPC UA；
- 重启 iec104-slave → 约 10s 后回切 `iec104`；
- 写命令 `dual-link:STA1_BUS_VOLTAGE` 路由到当前活跃实例。

- [ ] **Step 2: 节点级健康触发**

复用 Task 18 的双进程配置，主节点用 iec104 实例（从站 2404）。停掉主节点对端的从站（且主节点无其他插件）→ 主节点 `data_healthy=false` 连续 3 次心跳 → 备机 claim 接管并升主。

Expected：备机日志 `claim accepted` / `promoted to ACTIVE`；`GET /api/redundancy/status` 两端状态正确；恢复从站后按原回切流程回切。

- [ ] **Step 3: 清理临时配置**

删除 `config-instance.yaml` 等临时文件（确认路径后执行）。

---

## Part B 自审记录

- **Spec 覆盖**：节点级采集健康触发（Task 22/23/26/30）、实例级组配置与校验（Task 19/20）、PointManager 逻辑映射（Task 21）、Registry 监督器与切换/回切（Task 24）、web API 与 UI（Task 25/27/28）、bin 接线（Task 26）、E2E（Task 30）。无缺口。
- **类型一致性**：`PluginRow.redundancy_group/redundancy_role/priority` 贯穿 db/config/web/TS；`PluginInstance` 新字段贯穿 config/registry/web；`HeartbeatInfo` 三字段与 `ClaimBody.role` 在 engine/web 一致；`InstanceGroupStatus` 与 TS 类型逐字段对齐。
- **占位符扫描**：无 TBD/TODO；所有修改点均给出完整代码或精确位置。
