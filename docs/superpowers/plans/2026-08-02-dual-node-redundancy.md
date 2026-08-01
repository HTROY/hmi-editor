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
