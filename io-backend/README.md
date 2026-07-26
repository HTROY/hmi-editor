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

- Rust 1.70+ (with wasm32-unknown-unknown target)
  ```
  rustup target add wasm32-unknown-unknown
  ```

### 构建所有组件

```powershell
cd io-backend
.\build.ps1 -Release
```

或分步构建：

```powershell
# 1. 构建 WASM 协议插件
cd io-backend
.\build.ps1 -Release -PluginsOnly

# 2. 构建 Rust 后端
.\build.ps1 -Release -BackendOnly
```

### 手动构建

```bash
# 构建 WASM 插件
cd plugins-src/modbus-tcp && cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/modbus-tcp-plugin.wasm ../../plugins/modbus_tcp.wasm

cd ../opc-ua && cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/opc-ua-plugin.wasm ../../plugins/opc_ua.wasm

cd ../iec104 && cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/iec104-plugin.wasm ../../plugins/iec104.wasm

# 构建后端
cd ../.. && cargo build --release
```

## 运行

```bash
cd io-backend
cargo run -- config.yaml
```

服务启动后会：
1. 从 `config.yaml` 加载配置（点位映射表）
2. 扫描 `plugins/` 目录加载 .wasm 插件
3. 初始化并连接所有协议插件
4. 启动周期性扫描（默认 500ms）
5. 在 `ws://0.0.0.0:8080/iscs/data` 监听 WebSocket 连接

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
        - id: "STA1_211_ACB_STATUS"     # 必须与前端 VariableDef.id 一致
          address: "coil:0"
          data_type: "bool"
          var_type: "DI"
```

## 前端连接

1. 启动 `hmi-editor` 前端：`npm run dev`
2. 打开"数据连接"面板
3. 选择"IO 后端"数据源
4. 点击"连接"

## WASM 插件接口

每个 .wasm 插件需实现：

**导出函数 (Host → Plugin):**
- `plugin_init(config_ptr, config_len) → i32`
- `plugin_connect() → i32`
- `plugin_disconnect() → i32`
- `plugin_scan_points() → i32`
- `plugin_write_point(name_ptr, name_len, value_ptr, value_len) → i32`
- `plugin_get_name(ptr, max_len) → i32`
- `plugin_get_status() → i32`
- `plugin_alloc(size) → *mut u8`
- `plugin_free(ptr, size)`

**导入函数 (Plugin → Host):**
- `host_on_point(name_ptr, name_len, value, quality_ptr, quality_len, timestamp)`
- `host_log(level, msg_ptr, msg_len)`
- `host_now_ms() → i64`

## 目录结构

```
io-backend/
├── config.yaml              # 默认配置
├── build.ps1                # 构建脚本
├── Cargo.toml               # 后端依赖
├── src/                     # Rust 后端源码
│   ├── main.rs
│   ├── config.rs
│   ├── plugin/              # WASM 插件宿主
│   │   ├── host.rs          # wasmtime 引擎封装
│   │   ├── interface.rs     # 插件接口定义
│   │   └── registry.rs      # 插件生命周期管理
│   ├── point/               # 点位管理
│   │   ├── types.rs
│   │   └── manager.rs
│   ├── bridge/              # 桥接层
│   │   └── bridge.rs
│   └── server/              # WebSocket 服务
│       └── ws.rs
├── plugins/                 # .wasm 编译产物
│   ├── modbus_tcp.wasm
│   ├── opc_ua.wasm
│   └── iec104.wasm
└── plugins-src/             # 插件源码
    ├── modbus-tcp/
    ├── opc-ua/
    └── iec104/
```
