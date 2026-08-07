# 后端报警/SOE 改造设计

## 目标

把报警判定与 SOE 记录从前端 `AlarmManager` 移到 Rust 后端，由 Active 节点统一计算、持久化并推送；前端报警面板重设计并修复显示错误；仿真模式保留本地降级。

## 已确认决策

- 后端 DB 为报警规则的唯一事实来源；HMI 编辑器与管理端经 REST 编辑，规则变更广播并进入冗余配置快照。
- 规则字段：`id/variable_id/name/description/severity/group/condition/threshold/enabled/hysteresis/confirm_ms`；条件保留 `high/low/equal/notEqual/change`，`change` 为瞬时报警（不驻留活跃表）。
- 判定语义：非 good 质量暂停判定（质量保持）；支持滞回与确认时间；恢复为正常值即自动恢复；规则停用/删除时活跃报警立即恢复（原因“规则停用/删除”）。
- 确认：未确认的活跃报警与已恢复未确认报警都可确认；“确认全部”= 全部未确认；确认人/时间持久化并广播。
- SOE：所有点位变位（可按点配置）记录；设备时间优先、接收时间兜底；同毫秒用自增序号排序。
- 历史：`alarm_occurrences`（摘要）+ `alarm_stream_events`（明细事件流）双表；默认报警历史保留 90 天、SOE 保留 30 天，可配置。
- 冗余：仅 Active 节点计算；活跃报警状态持久化，重启/升主后用当前点位值重建；备用节点不计算。
- 管理 Web UI 本轮不加页面，但 API/WS 按多端消费设计。

## 修订（规则编辑归属管理端）

- 报警规则管理页新增到管理端（`/alarm/rules`，Table + Modal 表单），为规则唯一写入口；后端 `/api/alarm/rules` 支持 id 留空自动生成。
- 管理端新增报警监控页（`/alarm`）：活跃/历史/SOE，支持确认/全确认；活跃 2 秒轮询、历史/SOE 10 秒轮询，操作后立即刷新；操作员名来自顶栏输入（localStorage 记忆）。
- HMI 编辑器连接后端时不展示规则界面；仅仿真模式在全屏报警中心显示本地规则编辑器。
- HMI 移除变量面板高/低限快捷同步，并清理 `alarmHigh/alarmLow` 字段。

## 后端组件

新增 crate `hmi-io-alarm`：

- `types.rs`：规则、报警发生记录、明细事件、SOE 记录。
- `engine.rs`：无 IO 的判定状态机（输入 PointValue，输出 OutEvent），含滞回、确认时间、质量保持、瞬时报警、确认/全确认、规则增删改、重建。
- `persist.rs`：消费 OutEvent，写 SQLite 并经现有 broadcast 通道推送 WS。

DB 新增表：`alarm_rules`、`alarm_occurrences`、`alarm_stream_events`、`soe_events`（幂等迁移）；`server_config` 新增 `alarm_retention_days`、`soe_retention_days`。

WS 新消息：`alarm_snapshot`（连接时活跃报警）、`alarm_update`（单条变化，含 event_type 与 occurrence）、`soe`（批量增量）、`alarm_rules`（连接时规则快照）、`alarm_rules_changed`（规则变更通知）。

REST 新端点：`/api/alarm/rules` CRUD、`/api/alarm/active`、`/api/alarm/history`、`/api/alarm/occurrences/{id}/events`、`/api/alarm/ack`、`/api/alarm/ack-all`、`/api/soe`、`/api/alarm/config`。

## 前端组件

- `WebSocketClient` 新增 alarm 消息路由（`alarm_snapshot/alarm_update/soe/alarm_rules/alarm_rules_changed`）。
- `AlarmManager` 改为双模式：`local`（仿真降级，同语义本地引擎）与 `remote`（WS + REST）。
- `AlarmPanel` 三 tab（活跃/历史/SOE）+ 全屏报警中心；报警中心含规则管理。
- 修复显示错误：历史 tab 空白、恢复/搁置状态文案、SOE 质量样式、时间无日期、历史重复、change 卡死等。

## 验证

- 后端：`cargo test`（引擎单测：触发/恢复/滞回/确认/质量保持/瞬时报警/规则停用/确认语义）+ `cargo build`。
- 前端：`npm run build`（tsc 类型检查）。
