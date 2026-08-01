# 插件实例作用域变量设计

日期：2026-08-02

## 背景与问题

当前 HMI 变量与后端点位以 `variable_id`（变量名）为唯一标识，导致不同插件实例的同名变量在 HMI 中被合并为同一个变量：

- DB `points` 表约束为 `UNIQUE(plugin_id, variable_id)`，允许不同插件实例使用相同变量名；
- `PointManager` 以 `variable_id` 为键，同名点位后写覆盖前写，`/api/points` 甚至会过滤掉重复行；
- 插件宿主 `on_point` 推送的 `PointValue.id` 只有变量名，不带实例信息；
- 前端 `DataBridge` 按 `variable_id` 去重合并；
- 控制命令 `registry.write_point` 广播给所有插件，首个成功者生效，路由不确定。

需求：不同插件实例中的同名变量应绑定为不同的 HMI 变量。

## 决策

- 方案 A：直接拆分，不提供旧 ID 兼容层。
- 组合 ID 格式：`插件实例名:变量名`，例如 `modbus_1:STA1_TEMP_ZONE1` 与 `modbus_2:STA1_TEMP_ZONE1`。
- 实例命名空间使用 `plugins.name`（DB 已由 UNIQUE 约束保证唯一）；同一协议的多个实例使用不同实例名即可。
- 配置加载/迁移时对重复实例名显式报错，不再静默跳过。

## 设计

### 组合 ID

- `hmi-io-point` 新增 `point_key(plugin_name, variable_id) -> String`，格式为 `{plugin_name}:{variable_id}`，作为组合 ID 的唯一实现点。
- 约定：插件实例名与变量名均不得包含 `:`（现状命名满足）。

### 后端改动

1. `PointManager`：缓存键改为 `point_key`；`from_config` 按实例逐点插入组合键；`update`、`get_all_values`、`has_point`、`count` 随之按组合键工作，同名点在不同实例下互不覆盖。
2. 插件宿主 `host.rs` 的 `on_point`：Monitor 更新继续使用原始变量名（监控页按插件分组不变）；写入 `point_tx` 的 `PointValue` 使用组合 ID。
3. `registry.write_point`：基于 `config_cache` 建立「组合 ID → (实例名, 原始变量名)」路由，只向目标实例发送 `WritePoint`（参数仍为原始变量名）；找不到时返回错误，不再广播。
4. `hmi-io-db`：`PointRow` 增加 `plugin_name` 字段；`list_points` / `get_point` 的 SQL JOIN `plugins` 表取实例名。
5. `hmi-io-web` 的 `list_points`：用 `point_key(plugin_name, variable_id)` 调用 `has_point` 过滤；响应中增加 `plugin_name` 与 `hmi_id`（`hmi_id` 由 API 层通过 `point_key` 填充）。
6. 配置校验：YAML 中插件实例名重复时启动显式报错（`build_config` 改为返回 `Result`）；DB 路径由 UNIQUE 约束保证。

### 前端改动

`DataBridge.fetchVariablesFromBackend`：

- 删除按 `variable_id` 去重的逻辑；每个后端点位导入为一个 HMI 变量：`id = hmi_id`（后端字段，缺失时以 `plugin_name + ":" + variable_id` 兜底）、`name = variable_id`、`group = 插件名`；
- `pointIdToVarId`：DB id → `hmi_id`，`hmi_id` → `hmi_id`；不再把裸 `variable_id` 映射为 HMI 变量；
- `varIdToPointId`：`hmi_id` → `hmi_id`（控制命令直接发送组合 ID，由后端路由到实例）；
- 更新相关注释与日志。

### 保持不变

- WIT 契约与三个 WASM 插件 guest：插件内部仍使用原始 `variable_id`；
- SQLite 表结构：无迁移；
- `web-ui` 管理页面：新增 JSON 字段向后兼容，管理逻辑不变；
- WebSocket 消息协议结构不变，仅 `id` 字段值变为组合 ID；订阅过滤与控制命令直接使用组合 ID，无需改动 `ws.rs` 协议处理。

## 验证清单

按 TDD 先写失败测试：

1. `PointManager`：两个插件实例配置同名点 → `count() == 2`、两个组合键 `has_point` 均为 true、分别更新互不影响；
2. `point_key` 工具函数测试；
3. 组合 ID → 写入目标解析辅助函数测试（纯函数，便于单测）。

实施后验证：

4. `cargo test`（io-backend）全部通过；
5. 前端 `npm run build`（tsc + vite）通过；
6. 手工 E2E：现有 `config.yaml`（modbus_tcp / opc_ua / iec104 已含多个重名点）启动后端，HMI 变量列表出现同名但组合 ID 不同的多个变量，值分别随对应实例更新，控制命令写入正确实例；
7. 重复实例名的配置启动时得到明确报错。

## 兼容性与影响

- 已保存 HMI 项目中的旧变量绑定失效，需要重新绑定（用户已确认方案 A，不做兼容层）。
- `hmi_io.db` 无需迁移。
- 重命名插件实例会使 HMI 变量 ID 改变，需要重新绑定对应变量。

## 非目标

- 不做旧 ID 兼容层、不加「冗余合并」开关；
- 不改 WIT 契约与插件 guest；
- 不改 SQLite 表结构；
- 不重构 `web-ui` 管理界面。
