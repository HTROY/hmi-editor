# 双机主备冗余设计（v2：叠加实例级冗余）

日期：2026-08-02（v1 2026-08-02，v2 增加节点级采集健康触发与实例级冗余）

## 背景与问题

当前后端是单进程部署：`PointManager` 只负责点值缓存、缩放与去重；插件实例全部运行在同一后端进程内；HMI 前端的 `WebSocketClient` 只支持单个 WS 地址；web-ui 只有插件、点位、实时监控三个管理页。

需求：

1. 为 `io-backend/crates/point` 中的 `PointManager` 增加进程级主备冗余能力，并在 `web-ui` 中新增冗余配置与监控页面，HMI 前端支持主备双地址自动切换。
2. 主节点插件无法连接/获取数据时，备节点应能接管（节点级采集健康触发）。
3. 同一进程内多插件实例场景下，支持**实例级主备冗余**：一个组 = 1 个 primary + 0..N 个 backup（显式配置组名、角色、切换优先级），主实例连不上时只切换该组的采集链路，HMI 变量 ID 保持稳定。

## 决策摘要

以下决策均已与用户确认：

- 冗余层级：后端进程级双机热备（两个完整后端进程）。
- 选主方式：静态角色（`primary` / `backup`）+ 心跳探测，双通道校验降低误切。
- 备机模式：值同步备机。备机不直接采集，由 Active 节点推送点值。
- 回切策略：自动回切，带稳定期（`failback_delay_ms`），避免抖动。
- 配置一致性：Active 节点推送完整配置快照，备机写入本地 DB。
- 节点级采集健康触发：主节点“没有任何插件能取到数据”时，备机可接管（叠加在心跳之上，带阈值与冷却）。
- 实例级冗余：同进程内 `redundancy_group + role(primary|backup) + priority` 显式分组，1 主 + 0..N 备，按 `priority` 升序切换；实例级在单机模式同样生效。
- 实现位置：冗余引擎内嵌 `hmi-io-point` crate（`redundancy` 模块）；实例级监督器位于 `hmi-io-plugin` registry。
- HMI 前端：`WebSocketClient` 支持主备地址列表自动切换；实例级组逻辑 ID 保证变量绑定不失效。

## 总体架构（节点级）

每个后端进程内置一个 `RedundancyManager`（`crates/point` 的 `redundancy` 模块），与 `PointManager` 配合。冗余关闭（`enabled=false`）时节点级冗余任务不运行，单机行为与现状一致（实例级冗余仍可独立生效）。

### 角色与运行态

- 静态角色：`primary`（主机）/ `backup`（备机）。
- 运行态：`Active`（对外服务）/ `Standby`（只收同步，不对外服务）。
- 正常态：primary = Active，backup = Standby。

职责：

- `Standby`：心跳探测 Active；接收值同步与配置快照；不启动插件；WS 连接被拒绝；写命令被拒绝。
- `Active`：运行插件采集（含实例级主备切换）；经 Bridge 广播；接受 WS 与写命令；向对端推送心跳、值同步与配置快照。

### 状态转移

- **备机升主（心跳丢失）**：Standby 连续 `failover_threshold` 次心跳失败，且 WS 端口 TCP 探测也失败 → Active：从本地配置启动插件、接受 WS/写命令、推送心跳与同步。
- **备机升主（采集不健康）**：心跳正常但对端上报 `data_healthy=false` 连续 `plugin_unhealthy_threshold` 次 → 发接管请求（claim），对端确认降级后升主；claim 时对端不可达则直接升主。
- **主机恢复（failback）**：恢复的主机先以 Standby 进入并拉全量快照；连续 `failback_delay_ms` 健康心跳后发 claim（角色 primary），当前 Active 确认降级，主机升 Active。
- **进程启动**：先探测对端；对端 Active → Standby 拉快照；不可达 → primary 直接 Active，backup 等待阈值后 Active。
- **脑裂兜底**：双通道校验降低误切；双 Active 时监控页红色告警；Active 收到对端推值（说明对端也认为自己 Active）时标记分裂——若本机是 backup 则自动降级，primary 保持。HMI 前端优先连接主节点。
- **防抖动**：健康触发的升主受 `plugin_promotion_cooldown_ms` 冷却限制；心跳丢失触发的升主不受限。

## 节点级采集健康触发

- 定义：`data_healthy = 至少一个插件实例 connection_state==2 且最近 3 个扫描周期内有成功扫描`。由 bin 侧闭包基于 `MonitorCollector` 计算，Active 节点每个心跳周期自评并随心跳上报。
- 心跳消息新增字段：`data_healthy`、`plugins_total`、`plugins_connected`。
- claim 请求体新增 `role`；接受规则：
  - 自己已是 Standby → 接受（幂等）；
  - 自己 Active 且请求方角色为 `primary` → 接受（自动回切）；
  - 自己 Active 且自己 `data_healthy=false` → 接受（采集健康触发的接管）；
  - 其余情况（Active 且健康、请求方为 backup）→ 拒绝。
- 实例级冗余会把单条链路故障消化在 Active 节点内部；整组全挂且无其他可用插件时 `data_healthy=false`，才触发节点级接管。

## 实例级冗余（叠加层）

### 配置模型

插件实例增加两个可选字段与一个优先级字段：

- `redundancy_group`：组名（如 `mb-link`），HMI 逻辑变量 ID 前缀。
- `redundancy_role`：`primary` | `backup`（组内角色）。
- `priority`：仅 backup 使用，整数 ≥1，组内唯一；数字越小越先接管。

组规则：

- 声明组的实例必须同时声明角色；未声明组的实例为独立单实例（不受实例级冗余管理）。
- 每个组恰好 1 个 primary、0..N 个 backup（只配主、不带备允许）。
- HMI 逻辑变量 ID = `组名:变量名`；组内所有成员共享同一组逻辑 ID，切换不改变前端绑定。
- 切换顺序：primary → priority=1 → priority=2 → …；全部成员失败后回到 primary 重新尝试（环形兜底，保持顺序语义）。

校验规则：

- 组内 primary 唯一；backup 必须填 `priority` 且组内不重复；primary 不允许填 `priority`；
- `redundancy_group` 与 `redundancy_role` 成对出现；一个实例只能属于一个组、一个角色；
- 每个 backup 的点位 `variable_id` 集合必须与同组 primary 完全一致（一一对应）。

阈值配置（`redundancy` 块，实例级在单机模式同样生效）：

- `instance_failover_threshold`（默认 3）：活跃成员连续 N 次未连接/扫描失败/数据超时 → 切换；
- `instance_failback_enabled`（默认 true）：主实例恢复后自动回切；
- `instance_failback_delay_ms`（默认 30000）：回切探测间隔/稳定期；
- `instance_switch_cooldown_ms`（默认 60000）：同组两次切换最小间隔。

### 运行机制（Registry 层）

- 组状态表：每组记录有序成员（primary 在前，backup 按 `priority` 升序）、当前活跃成员、连续失败次数、回切探测计数、上次切换时间与原因、切换次数。
- 启动时每组只启动 primary 一个成员（连接采集）；备成员不加载，切换时动态加载（WASM 加载 + 连接，切换延迟数秒）。
- 监督任务每 `scan_interval_ms` tick 一次：活跃成员 `connection_state==2` 且最近扫描新鲜 → 健康；否则连续失败 +1。
- 切换：连续失败 ≥ `instance_failover_threshold` 且距上次切换 ≥ `instance_switch_cooldown_ms` → 关闭当前成员、按顺序启动下一个；切换后更新 `PointManager.set_active_instance(组, 实例)` 与写路由。
- 回切：活跃成员是 backup 且 `instance_failback_enabled` → 每 `instance_failback_delay_ms` 探测 primary（加载并 connect，成功则接管，失败则立即关闭探测实例并等待重试）；探测期间写命令仍路由到当前活跃 backup。
- 每次切换记录事件（组名、从谁切到谁、原因），经 `GET /api/redundancy/instance-groups` 供监控页展示。

### PointManager 逻辑映射

- `from_config` 构建两张映射：`实例键（实例名:变量名）→ 逻辑键（组名:变量名）`，以及组 → 当前活跃实例名（初始 = primary）。缓存按逻辑键存放。
- `update(raw)`：raw.id 是实例键；若属于组——只有活跃成员的值被缩放/去重并以逻辑键广播，非活跃成员的值直接丢弃；非组实例行为不变。
- `get_all_values()`/WS 快照返回逻辑键，前端变量 ID 永远稳定。
- Registry 切换时调用 `PointManager::set_active_instance(组, 实例)` 同步映射。

### 写命令路由

- `registry.write_point(逻辑键)`：`组名:变量名` → 查该组当前活跃实例 → 只写活跃实例；非组点按现有 composite 路由。

## 协议与数据流

新增冗余 API 复用 web 端口 8081，JSON over HTTP：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/redundancy/heartbeat` | 对端探测：`node_id / role / state / config_version / uptime_ms / data_healthy / plugins_total / plugins_connected` |
| POST | `/api/redundancy/sync` | Active → Standby 推值：`{node_id, config_version, points}` |
| GET | `/api/redundancy/snapshot` | 全量点值快照 |
| POST | `/api/redundancy/config/push` | Active → Standby 推送完整配置快照 |
| POST | `/api/redundancy/claim` | 接管/回切握手：`{node_id, role}`，返回 `{accepted}` |
| GET | `/api/redundancy/status` | 节点级状态（本机/对端/心跳/同步/事件/同步点位） |
| GET | `/api/redundancy/instance-groups` | 实例级组状态（成员、角色、priority、活跃、连接、切换历史） |
| GET | `/api/redundancy/config`、PUT | 读取/保存冗余配置 |

值同步与配置同步：

- Active 订阅 Bridge broadcast，把 data 消息转成 `/sync` 推给对端；每 `full_snapshot_interval_ms` 补推全量快照兜底。
- Standby 用 `PointManager.apply_sync()` 直接写入已缩放值，并更新冗余状态中的同步点位。
- 配置快照含插件（含组/角色/priority）、点位、server_config 与 `config_version`；Standby 校验版本后幂等替换本地 DB，不启动插件；接管时用本地最新配置启动。

## 配置存储

- `config.yaml` 顶层 `redundancy:` 块（全部字段 `#[serde(default)]`）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | false | 节点级双机开关 |
| `node_id` | "" | 节点 ID |
| `role` | primary | 节点静态角色 |
| `peer_url` | "" | 对端 web 地址 |
| `heartbeat_interval_ms` | 1000 | 心跳间隔 |
| `failover_threshold` | 3 | 心跳丢失升主阈值 |
| `failback_delay_ms` | 30000 | 回切稳定期 |
| `full_snapshot_interval_ms` | 5000 | 全量快照间隔 |
| `plugin_unhealthy_threshold` | 3 | 采集不健康升主阈值（连续上报次数） |
| `plugin_promotion_cooldown_ms` | 60000 | 健康触发升主冷却 |
| `instance_failover_threshold` | 3 | 实例级切换阈值（连续失败） |
| `instance_failback_enabled` | true | 实例级自动回切 |
| `instance_failback_delay_ms` | 30000 | 实例级回切探测间隔 |
| `instance_switch_cooldown_ms` | 60000 | 实例级切换冷却 |

- 插件实例增加 `redundancy_group`、`redundancy_role`、`priority`；DB `plugins` 表迁移新增三列（`redundancy_group TEXT NOT NULL DEFAULT ''`、`redundancy_role TEXT NOT NULL DEFAULT ''`、`priority INTEGER NOT NULL DEFAULT 0`）。
- 运行时配置存 DB `server_config`（`redundancy_config` JSON + `config_version`），`AppConfig::from_repo_sync` 读回。

## hmi-io-point 改动

- `PointManager`：`apply_sync`、`set_active/is_active`、组逻辑映射（`instance_to_logical`、`active_group_instance`、`set_active_instance`），缓存按逻辑键。
- `redundancy` 模块：
  - `state.rs`：`NodeState`、`RedundancyStatus`（含 `unhealthy_reports`、`rtt_history`、`synced_points` 等）、事件环、纯决策函数（`decide_initial_state`、`required_stable_beats`、`should_promote_unhealthy`）；
  - `engine.rs`：心跳循环、值/配置推送、claim（带角色与健康接受规则）、健康提供者（闭包注入）、冷却检查；
  - 序列化类型：`HeartbeatInfo`、`SyncBody`、`ClaimBody{node_id,role}`、`ClaimResult`、`ConfigPushBody`、`RoleCommand`。
- 依赖：新增精简 `reqwest`（关闭 TLS、仅 JSON）、tokio。

## hmi-io-plugin 改动

- `PluginRegistry`：`prepare`/`start_instances` 拆分；组状态表与实例级监督器；`set_point_manager`；`instance_groups_status()`；写路由按组解析到活跃实例。
- 启动时每组只启动 primary；监督器负责顺序切换、环形兜底与回切探测。

## web-ui 改动

- 菜单：`/redundancy`（冗余配置）、`/redundancy/monitor`（冗余监控）。
- 冗余配置页：节点级全部字段 + 实例级四个阈值字段；顶部显示本机/对端状态与分裂告警。
- 冗余监控页：节点级状态卡（角色、对端、心跳 RTT、同步延迟、切换次数、分裂告警）、事件表、同步点位表、RTT 趋势；新增“实例冗余组”表（组名、成员、角色、priority、活跃标识、连接状态、连续失败、切换次数、上次切换时间/原因）。
- 插件页：表格新增“冗余组/角色/优先级”列；表单新增对应字段（角色下拉：无/primary/backup；priority 仅 backup 显示）。
- 点位页：点位行显示组与角色标签；支持 `include_backup=true` 查看/编辑备实例点位。
- `api/types.ts`、`client.ts` 同步新增类型与接口。

## HMI 前端改动

- `WebSocketConfig.url` 扩展为 `urls: string[]`（主在前），断线按序重连、每次循环从主地址开始。
- 备机拒绝 WS / 降级断开 → 前端自然切换；`ConnectionPanel` 支持主备 WS 与备用 REST API 输入。
- 实例级组逻辑 ID 保证变量 ID 稳定，DataBridge 无需按实例切换做特殊处理。

## 错误处理

- 心跳丢失：连续 `failover_threshold` 次且 WS 端口 TCP 探测失败才切换；期间记事件。
- 采集不健康：连续 `plugin_unhealthy_threshold` 次上报才触发，且受 `plugin_promotion_cooldown_ms` 限制；claim 被拒（对端健康）则重置计数继续待命。
- 值同步失败：重试 + 全量快照兜底；同步中断不触发切换。
- 配置同步：版本号单调递增，旧版本忽略；失败标记“配置未同步”并在恢复后补推。
- 接管后插件启动失败：保持 Active 用最后同步值服务，每 5 秒重试启动，记录事件，不自动降级。
- 实例级切换：冷却期防抖动；全部成员失败后环形回到 primary 重试；回切探测失败不双跑（探测实例立即关闭）。
- 脑裂：红色告警 + 事件；backup 收到对端推值时自动降级，primary 保持。
- `enabled=false`：节点级不启动；实例级按组配置独立生效。

## 测试与验证

单元测试：

- config：默认值、YAML/DB 往返、节点级校验、实例组校验（primary 唯一、priority 必填且唯一、点集合一致、字段成对）；
- PointManager：组映射、活跃成员值以逻辑键广播、非活跃丢弃、切换后 ID 不变、apply_sync/门控；
- redundancy 状态与引擎：初始状态决策、回切稳定期、unhealthy 计数与决策、claim 接受/拒绝规则、事件环、sync 应用；
- registry：`next_member` 顺序切换与环形兜底、组构建；
- db：插件新字段往返、配置快照应用；
- web：`include_backup` 过滤与 `hmi_id` 逻辑。

集成/手工 E2E：

- 双进程：杀主 → 备升主；恢复主 → 自动回切；web-ui 改配置 → 备机同步；断网 → 分裂告警。
- 节点级健康触发：主节点整组全挂（停掉全部测试从站）→ 备机升主。
- 单机实例级：1 主（iec104→2404）+ 1 备（OPC UA→4840，同组变量）→ 停 2404 → 切到备实例采集，HMI 变量 ID 不变；恢复 2404 → 回切主实例。

构建：`cargo test`、web-ui `npm run build`、HMI 前端 `npm run build`。

## 兼容性与影响

- `enabled=false` 且无实例组时行为与现状完全一致；旧 `config.yaml` 无需迁移字段。
- `hmi_io.db`：`plugins` 表新增三列（幂等 `ALTER TABLE` 迁移）；`server_config` 新增 `redundancy_config`/`config_version` 键。
- 插件 API/UI 新增字段向后兼容（缺省为空/0）。
- WIT 契约与三个 WASM 插件 guest 不改。
- 双机部署要求：两机同一套配置（节点角色除外），`peer_url` 指向对端 web 端口。

## 非目标

- 不做跨机共享数据库、不引入外部协调服务（etcd/Redis 等）。
- 不做超过 2 节点的多机冗余、不做手动强制切换按钮。
- 不做备实例同时采集/负载均衡（同一时刻一组只有一个活跃成员采集）。
- 不做跨节点实例配对（主实例在 A 机、备实例在 B 机）——跨机故障由节点级双机覆盖，实例级只做同进程内配对。
- 不做任意点位级合并（组外不同实例的同名变量仍是不同 HMI 变量）。
- 不改 WIT 契约与插件 guest。
