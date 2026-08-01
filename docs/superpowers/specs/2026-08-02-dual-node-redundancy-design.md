# 双机主备冗余设计

日期：2026-08-02

## 背景与问题

当前后端是单进程部署：`PointManager` 只负责点值缓存、缩放与去重，没有任何冗余概念；HMI 前端的 `WebSocketClient` 只支持单个 WS 地址；web-ui 只有插件、点位、实时监控三个管理页。

需求：为 `io-backend/crates/point` 中的 `PointManager` 增加进程级主备冗余能力，并在 `web-ui` 中新增冗余配置与监控页面，同时让 HMI 编辑器前端支持主备双地址自动切换。

## 决策摘要

以下决策均已与用户确认：

- 冗余层级：后端进程级双机热备（两个完整后端进程）。
- 选主方式：静态角色（`primary` / `backup`）+ 心跳探测，双通道校验降低误切。
- 备机模式：值同步备机。备机不直接采集，由 Active 节点推送点值。
- 回切策略：自动回切，带稳定期（`failback_delay_ms`），避免抖动。
- 配置一致性：Active 节点推送完整配置快照，备机写入本地 DB。
- 实现位置：方案 1——冗余引擎内嵌 `hmi-io-point` crate（新增 `redundancy` 模块），与 `PointManager` 同 crate 协作。
- HMI 前端：`WebSocketClient` 支持主备地址列表自动切换。

## 总体架构

每个后端进程内置一个 `RedundancyManager`（位于 `crates/point` 的 `redundancy` 模块），与 `PointManager` 配合工作。冗余关闭（`enabled=false`）时完全不启动冗余任务，单机行为与现状完全一致。

### 角色与运行态

- 静态角色：`primary`（主机）/ `backup`（备机），来自配置。
- 运行态：`Active`（对外服务）/ `Standby`（只接收同步，不对外服务）。
- 正常态：primary = Active，backup = Standby。

各运行态职责：

- `Standby`：按心跳间隔探测 Active 节点；接收值同步与配置快照并写入本地 `PointManager` 缓存与本地 DB；不启动插件；WS 连接被拒绝；写命令被拒绝。
- `Active`：运行插件采集；经 Bridge 广播点值；接受 WS 连接与写命令；向对端推送心跳、值同步与配置快照。

### 状态转移

- **备机升主（failover）**：Standby 连续 `failover_threshold` 次心跳失败，且对 Active 节点 WS 端口的 TCP 探测也失败时，提升为 Active：从本地配置启动插件注册表、接受 WS 与写命令、开始向对端推送心跳/值同步。
- **主机恢复（failback）**：恢复的主机启动后先探测对端——对端为 Active 时以 Standby 身份进入并拉取全量快照；连续 `failback_delay_ms` 健康心跳后向当前 Active 发起回切握手（`claim`）；当前 Active 确认后降级（断开全部 WS 客户端、停止采集、转为接收同步），恢复的主机升为 Active。握手避免双主同时服务。
- **进程启动**：先探测对端。对端 Active 可达 → 本机进 Standby 并拉快照；对端不可达 → primary 直接 Active，backup 等待 `failover_threshold` 心跳周期后 Active。
- **脑裂兜底**：静态角色 + 双通道校验降低误切概率；极端分区下若出现双 Active，监控页显示红色分裂告警并记录事件，HMI 前端优先连接主节点地址。不做自动杀进程。

## 协议与数据流

新增冗余 API 全部复用 web 端口 8081，JSON over HTTP，不新增端口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/redundancy/heartbeat` | 返回本机 `node_id / role / state / config_version / uptime_ms / peer_state`，供对端探测与监控展示 |
| POST | `/api/redundancy/sync` | Active → Standby 推值：`{node_id, config_version, points: PointValue[]}` |
| GET | `/api/redundancy/snapshot` | 全量点值快照，备机启动、降级后主动拉取 |
| POST | `/api/redundancy/config` | Active → Standby 推送完整配置快照（插件 + 点位 + 冗余设置版本） |
| POST | `/api/redundancy/claim` | 回切握手，恢复的主机请求当前 Active 降级，返回 `{accepted}` |
| GET | `/api/redundancy/status` | web-ui 监控数据源：本机/对端状态、心跳统计、同步统计、事件历史 |

### 值同步

- 不重造采集链路：Active 的 `RedundancyManager` 直接订阅 Bridge 现有的 broadcast 通道，将 data 消息转发为 `/api/redundancy/sync` 推给对端。
- 每 `full_snapshot_interval_ms`（默认 5000ms）补推一次全量快照，兜底丢包与备机重启。
- Standby 收到 `/sync` 后调用 `PointManager.apply_sync()` 直接写入已缩放值（不二次缩放/去重），并同步更新 `MonitorCollector`，使备机监控页也能看到最新值。
- 监控页展示值同步延迟（点值时间戳与当前时间差）。

### 配置同步

- 维护单调递增的 `config_version`。
- web-ui 的插件/点位 CRUD 或冗余设置变更后，Active 递增版本并推送 `/api/redundancy/config` 完整快照。
- Standby 校验版本后幂等替换本地 DB（plugins / points / server_config），不启动插件。
- 备机接管时用本地最新配置启动插件；若配置缺失，先拉取快照再启动。

## hmi-io-point 改动

### PointManager 新增接口

- `apply_sync(points: Vec<PointValue>)`：备机直接写入缓存。
- `set_active(bool)` / `is_active()`：角色门控，Standby 不广播、拒绝写命令。
- `snapshot()`：全量导出（复用现有 `get_all_values`）。

### 新增 redundancy 模块

- `RedundancyConfig`：冗余配置（serde 反序列化）。
- `RedundancyManager`：tokio 后台心跳任务、选主状态机、对端 HTTP 调用、值/配置同步任务、事件环形缓冲（最近 100 条）。
- 序列化类型：`Role`、`NodeState`、`RedundancyStatus`、`RedundancyEvent`（供 web-ui 使用）。

### 依赖

`hmi-io-point` 新增精简 HTTP 客户端依赖（`reqwest`，关闭默认 TLS、仅启用 JSON 特性）。若构建环境不便引入，可退化为直接使用 axum 已带的 hyper 客户端。

## 配置存储

- `config.yaml` 顶层新增可选 `redundancy:` 块；`AppConfig` 增加 `RedundancyConfig`，所有字段 `#[serde(default)]`，旧配置无需迁移。
- 字段：`enabled`、`node_id`、`role(primary|backup)`、`peer_url`、`heartbeat_interval_ms`（默认 1000）、`failover_threshold`（默认 3）、`failback_delay_ms`（默认 30000）、`full_snapshot_interval_ms`（默认 5000）。
- 运行时配置写入 DB `server_config` 表（JSON 值，键 `redundancy_config`），另存 `config_version`；`AppConfig::from_repo_sync` 读回，保证 web-ui 修改后重启不丢。
- 校验：`enabled=true` 时 `node_id`、`role`、`peer_url` 必填，`role` 只能是 `primary` 或 `backup`。

## web-ui 改动

侧边栏新增两个菜单：

- **冗余配置** `/redundancy`：表单编辑全部冗余字段，保存走 `PUT /api/redundancy/config`；页面顶部显示本机当前状态（角色/活跃态/对端可达性/配置版本），冗余未启用时给出提示。
- **冗余监控** `/redundancy/monitor`：
  - 状态卡片：本机角色与活跃态、对端可达性、心跳延迟（滚动平均）、值同步延迟、配置版本、分裂告警（红色条）。
  - 事件表：角色切换、心跳丢失/恢复、配置同步、claim 握手结果等最近 100 条，含时间与原因。
  - 同步点位表：备机视角的最近点位值与时间戳（复用 MonitorCollector），按同步延迟排序。
  - 心跳 RTT 趋势小图（复用现有 ECharts hook）。

`web-ui/src/api/client.ts` 与 `types.ts` 增加对应类型与方法。

## HMI 前端改动

- `WebSocketConfig.url` 扩展为 `urls: string[]`（主地址在前），兼容旧字段。
- 重连逻辑：按顺序尝试地址，连接成功后停留；每次重连优先从主地址开始，避免长期挂在备机。
- 备机不提供 WS 服务（连接被拒绝/立即断开），前端自然切换；Active 节点降级时服务端主动断开全部 WS 客户端，前端据此切换到新主机。
- `ConnectionPanel` 支持配置主备两个 WS 地址；`fetchVariablesFromBackend` 的 API 地址按主备顺序尝试。

## 错误处理

- 心跳探测失败只记事件；连续 `failover_threshold` 次失败且双通道（web API + WS 端口 TCP）均不可达才触发切换。
- 值同步失败：重试 + 全量快照兜底；同步中断不触发切换，切换判定只看心跳。
- 配置同步冲突：版本号单调递增，旧版本/重复版本忽略；对端不可达时标记“配置未同步”并在监控页告警，恢复后自动补推。
- 接管后插件启动失败：保持 Active 用最后同步值继续服务，每 5 秒重试启动插件，事件表记录错误，不自动降级。
- 双 Active 脑裂：监控页红色告警 + 事件记录，前端主地址优先。
- 进程重启：先探测对端；对端 Active → Standby 拉快照；不可达 → 按静态角色恢复（见状态转移）。
- `enabled=false`：不启动冗余任务，单机行为与现状一致。

## 测试与验证

- `cargo test`：状态机转移（升主阈值、回切稳定期、claim 握手）、`apply_sync`/快照、配置版本校验、事件环形缓冲；现有测试保持全绿。
- `web-ui` 与 HMI 前端分别 `npm run build` 通过。
- 手工 E2E：本机两个端口模拟主备双进程——杀主进程验证备机升主与前端切换；恢复主进程验证自动回切；web-ui 改配置验证备机同步；阻断网络验证分裂告警。

## 兼容性与影响

- `enabled=false` 时行为完全不变；旧 `config.yaml` 无需迁移字段。
- `hmi_io.db` 无表结构迁移，仅新增 `server_config` 键。
- WIT 契约与三个 WASM 插件 guest 不改。
- 双机部署要求：两机使用同一套配置（角色字段除外），`peer_url` 指向对端 web 端口。

## 非目标

- 不做跨机共享数据库、不引入外部协调服务（etcd/Redis 等）。
- 不做点位级主备合并（此前 spec 已明确排除）。
- 不做超过 2 节点的多机冗余。
- 不做手动强制切换按钮。
- 不改 WIT 协议与插件 guest。
