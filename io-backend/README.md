# HMI I/O Backend — Rust + WASM Plugin System

基于 Rust + wasmtime 的工业协议 I/O 后端，通过动态加载 WASM 插件实现 Modbus TCP、OPC UA、IEC 60870-5-104 协议到 SCADA IO 点位的实时转换。

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    Rust Backend Service                           │
│                                                                   │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                     │
│  │ Modbus   │   │ OPC UA   │   │ IEC 104  │   WASM Plugins      │
│  │ Plugin   │   │ Plugin   │   │ Plugin   │   (.wasm files)     │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘                     │
│       │               │               │                          │
│  ┌────┴───────────────┴───────────────┴────┐                     │
│  │         WASM Plugin Host (wasmtime)      │                     │
│  └────────────────────┬────────────────────┘                     │
│  ┌────────────────────┴────────────────────┐                     │
│  │    Bridge: plugin callbacks → point mgr  │                     │
│  └────────────────────┬────────────────────┘                     │
│  ┌────────────────────┴────────────────────┐                     │
│  │   WebSocket Server (tokio-tungstenite)   │                     │
│  └────────────────────┬────────────────────┘                     │
└───────────────────────┼──────────────────────────────────────────┘
                        │ WebSocket (JSON)
                ┌───────┴───────┐
                │  hmi-editor   │
                │  (Browser)    │
                └───────────────┘
```

## 构建

### 前置条件

- Rust 1.82+（`wasm32-wasip2` 目标为 Tier 2）
  ```
  rustup target add wasm32-wasip2
  ```
- wasmtime 47 由后端 `Cargo.toml` 引入，无需单独安装

### 构建所有组件

```powershell
.\scripts\build.ps1 -Release
```

（脚本位于仓库根 `scripts/`，从仓库根或 `io-backend/` 下运行均可。）

或分步构建：

```powershell
# 1. 构建 WASM 协议插件
.\scripts\build.ps1 -Release -PluginsOnly

# 2. 构建 Rust 后端
.\scripts\build.ps1 -Release -BackendOnly
```

### 手动构建

```bash
# 构建 WASM 插件（wasip2 组件，产物名 = crate 名 + _plugin.wasm）
# 在 io-backend/（workspace 根）执行
cargo build --target wasm32-wasip2 -p modbus-tcp-plugin --release
cp target/wasm32-wasip2/release/modbus_tcp_plugin.wasm plugins/modbus_tcp.wasm

cargo build --target wasm32-wasip2 -p opc-ua-plugin --release
cp target/wasm32-wasip2/release/opc_ua_plugin.wasm plugins/opc_ua.wasm

cargo build --target wasm32-wasip2 -p iec104-plugin --release
cp target/wasm32-wasip2/release/iec104_plugin.wasm plugins/iec104.wasm

# 构建后端
cargo build --release
```

## 运行

```bash
cd io-backend
cargo run -- config.yaml
```

服务启动后会：

1. 首次启动将 `config.yaml` 迁移进本地 SQLite（`hmi_io.db`，此后配置改从数据库加载；删除 `hmi_io.db` 即可重新迁移）
2. 扫描 `plugins/` 目录加载 .wasm 插件
3. 初始化并连接所有协议插件
4. 启动周期性扫描（默认 500ms）
5. 在 `ws://0.0.0.0:8080/iscs/data` 监听 WebSocket 数据推送（批量 100ms）
6. 在 `:8081` 提供管理 Web UI 与监控 API（见下方「监控与调试」）

双机主备部署（可选）：两机使用同一套 `config.yaml`（`role`/`node_id`/`peer_url`/`peer_ws_port` 按机设置），`redundancy.enabled: true`；主机 Active 采集并推值，备机 Standby 只收同步，心跳丢失或主插件整组取不到数据时备机自动接管，数据恢复后自动回切。

## 配置

编辑 `config.yaml` 配置文件：

```yaml
server:
  host: "0.0.0.0"
  port: 8080

plugins:
  directory: "./plugins"
  scan_interval_ms: 500
  instances:
    - name: "modbus_tcp"
      wasm_file: "modbus_tcp.wasm"
      config:
        host: "192.168.1.100"
        port: 502
        slave_id: 1
      points:
        - id: "STA1_211_ACB_STATUS" # 必须与前端 VariableDef.id 一致
          address: "coil:0"
          data_type: "bool"
          var_type: "DI"
        - id: "STA1_211_ACB_CUR_A" # 32 位浮点示例
          address: "holding_register:2"
          data_type: "float32"
          byte_order: "ABCD" # ABCD/BADC/CDAB/DCBA（默认 ABCD）
          scale: 0.1
          var_type: "AI"
redundancy:
  enabled: false
  node_id: node-a
  role: primary
  peer_url: "http://192.168.1.2:8081"
  peer_ws_port: 8080
  heartbeat_interval_ms: 1000
  failover_threshold: 3
  failback_delay_ms: 30000
  full_snapshot_interval_ms: 5000
  plugin_unhealthy_threshold: 3
  plugin_promotion_cooldown_ms: 60000
  instance_failover_threshold: 3
  instance_failback_enabled: true
  instance_failback_delay_ms: 30000
  instance_switch_cooldown_ms: 60000
```

- `data_type`：`bool` / `int16` / `uint16` / `int32` / `uint32` / `float32`（默认 `uint16`）
- `byte_order`：`ABCD` / `BADC` / `CDAB` / `DCBA`（仅 modbus-tcp，默认 `ABCD`）
- 插件解码完成后统一应用 `scale`、`offset`

### 实例级主备（1 主 + 0..N 备，单机内）

同一 `redundancy_group` 的实例共享一组逻辑变量（HMI ID = `组名:变量名`），backup 按 `priority` 升序接管，切换不改变前端绑定：

```yaml
plugins:
  instances:
    - name: iec104
      redundancy_group: dual-link
      redundancy_role: primary
      wasm_file: iec104.wasm
      config: { host: "127.0.0.1", port: 2404, common_address: 1 }
      points:
        - { id: "STA1_211_IA", address: "1003", data_type: "float32", var_type: "AI" }
    - name: opc_ua_backup
      redundancy_group: dual-link
      redundancy_role: backup
      priority: 1
      wasm_file: opc_ua.wasm
      config: { endpoint: "opc.tcp://127.0.0.1:4840" }
      points:
        - { id: "STA1_211_IA", address: "ns=2;s=Temperature.Zone1", var_type: "AI" }
```

校验要求：组内 primary 唯一；backup 必须填 `priority` 且组内唯一；主备实例 `variable_id` 集合完全一致。

## 监控与调试

- 点值：`GET http://localhost:8081/api/monitor/plugins/<name>/points`
- 状态总览：`GET http://localhost:8081/api/monitor/overview`
- 报文追踪：`GET http://localhost:8081/api/monitor/plugins/<name>/packets`
- 冗余状态：`GET http://localhost:8081/api/redundancy/status`（节点级：角色/对端/心跳 RTT/同步/事件/分裂告警）
- 实例组状态：`GET http://localhost:8081/api/redundancy/instance-groups`
- 冗余配置读写：`GET/PUT http://localhost:8081/api/redundancy/config`
- Web UI：`http://localhost:8081/redundancy`（冗余配置）、`http://localhost:8081/redundancy/monitor`（冗余监控）
- WebSocket 写点（`ws://localhost:8080/iscs/data` 发送控制消息）：

```json
{ "command": "control", "variableId": "STA1_211_ACB_CTRL", "value": 1 }
```

## 前端连接

1. 启动 `hmi-editor` 前端：`npm run dev`
2. 打开"数据连接"面板
3. 选择"IO 后端"数据源
4. （可选）填写备用 WebSocket 地址与备用 REST API 地址，主节点故障时自动切换
5. 点击"连接"

## WASM 插件接口

插件是 WASIp2 组件（target `wasm32-wasip2`），契约的单一来源是 `io-backend/wit/hmi-plugin.wit`（package `hmi:plugin`）。

**插件导出（Host → Plugin，均为 async）：**

- `init(config-json)` — 接收插件配置 JSON（含实例 config 与点位映射表）
- `connect()` / `disconnect()`
- `scan-points()` — 周期扫描全部点位
- `write-point(name, value)`
- `get-name()` / `get-status()`

**插件导入（Plugin → Host）：**

- `log(level, message)` — 日志
- `on-point(name, value, quality, timestamp)` — 上报点位值
- `on-packet(direction, protocol, hex, summary)` — 上报原始报文追踪

**Guest 侧写法**（`crates/plugins/<plugin>/`）：

```rust
wit_bindgen::generate!({ world: "hmi-plugin", path: "../../../wit" });
// 实现 crate::exports::hmi::plugin::lifecycle::Guest，导出 export!(Plugin)
// 在 async 导出函数内直接 await 导入的 events::log / on_point / on_packet
```

**Host 侧**（`crates/plugin/`）：`bindgen!` + `wasmtime::component`，存储类型实现 `events::Host`（async import 返回 `Future<Output = ()>`），链接 `wasmtime_wasi::p2::add_to_linker_async`，经 `run_concurrent` 调用插件导出。

**modbus-tcp 插件**使用 `modbus` crate（v1.1）做协议编解码：`bool` 走线圈、16 位走单寄存器、32 位走连续双寄存器（按 `byte_order` 组字），解码后应用 `scale`/`offset`。

## 目录结构

```
io-backend/
├── config.yaml              # 默认配置（首次启动迁移进 hmi_io.db）
├── wit/hmi-plugin.wit       # WASM 插件契约（单一来源）
├── Cargo.toml               # Cargo workspace 根
├── crates/                  # 全部 Rust crate
│   ├── bin/                 # hmi-io-backend（可执行文件）
│   ├── config/              # hmi-io-config
│   ├── db/                  # hmi-io-db
│   ├── point/               # hmi-io-point
│   │   └── redundancy/      # 节点级冗余引擎（心跳/同步/回切状态机）
│   ├── monitor/             # hmi-io-monitor
│   ├── plugin/              # hmi-io-plugin（WASM 插件宿主）
│   │   ├── host.rs          # wasmtime 引擎 + events 导入实现
│   │   ├── interface.rs     # bindgen! 契约生成
│   │   └── registry.rs      # 插件生命周期管理
│   ├── bridge/              # hmi-io-bridge
│   ├── server/              # hmi-io-server（WebSocket 服务）
│   ├── web/                 # hmi-io-web（管理 API + UI 托管）
│   ├── plugins/             # 插件源码（WASM 组件）
│   │   ├── modbus-tcp/
│   │   ├── opc-ua/
│   │   └── iec104/
│   ├── shared/              # 共享协议 codec
│   │   ├── iec104-core/
│   │   └── ua-core/
│   └── test-servers/        # 本地测试服务器
│       ├── iec104-slave/
│       └── opcua-server/
├── plugins/                 # .wasm 编译产物
│   ├── modbus_tcp.wasm
│   ├── opc_ua.wasm
│   └── iec104.wasm
```
