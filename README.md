# HMI Editor

轨道交通 ISCS（综合监控系统）人机界面组态与采集一体化工具。仓库由三个相互协作的组件组成：

| 组件 | 目录 | 技术栈 | 职责 |
| --- | --- | --- | --- |
| 组态编辑器 | `src/` | React 19 · TypeScript 5.7 · Vite 6 · Zustand 5 · HTML5 Canvas | 画面组态、变量/绑定/动画、报警/趋势/权限/脚本/报表、工程管理 |
| I/O 采集后端 | `io-backend/` | Rust · wasmtime 47 · axum · SQLite | WASM 协议插件托管、点位采集与缩放、报警/SOE、主备冗余、管理 API |
| 管理 Web UI | `io-backend/web-ui/` | React 18 · Ant Design 5 · ECharts | 插件/点位/监控/报警/冗余的集中配置与监视 |

## 功能特性

### 组态编辑器

- **图元系统**：矩形、圆形、直线、文本、折线、多边形、路径、组、栅格图元，以及断路器、母线、变压器、风机、信号灯、仪表 6 类轨道交通专用图元。
- **工程级图元库**：自定义分组、库项覆盖更新与重新同步；SVG（含渐变/变换/路径）与 PNG/JPG 栅格图导入。
- **统一检查器**：右栏图元树（z 序、组内层级、拖拽换序、可见/锁定、重命名）+ 属性/绑定/动画编辑区。
- **数据绑定与动画**：direct/enum/range/stateColor/bitmask 五类值映射；闪烁、旋转、位移、缩放、变色五类动画，支持变量控制速度/强度/启停与 300ms 数值平滑过渡。
- **工程管理**：多页面、页面分辨率与背景、撤销/重做（含组内子图元命令）、自动保存（IndexedDB）、草稿备份、`.hmi.zip` 工程包（manifest + assets）、旧 `.hmi.json` 兼容升级。
- **工程同步**：连接后端后经 JWT 登录，可列出/拉取/推送远程工程，乐观锁版本冲突（409）明确提示。
- **数据连接**：内置模拟、IEC 104 模拟器、IO 后端 WebSocket 三种数据源；支持主备 WS 地址与备用 REST API 地址自动回退。
- **报警/趋势/权限/脚本/报表**：连接后端时消费后端报警与 SOE 推送，未连接时以语义一致的本地引擎降级仿真并标注"模拟"；历史趋势、RBAC、沙箱脚本、CSV/HTML 报表。

### I/O 采集后端

- **WASM 协议插件**：Modbus TCP、OPC UA、IEC 60870-5-104 三个 wasm32-wasip2 组件，契约单一来源为 `io-backend/wit/hmi-plugin.wit`。
- **点位管理**：插件实例点表统一管理，按 `实例名:变量名`（实例级冗余组为 `组名:变量名`）生成 HMI 点 ID；支持 `data_type`/`byte_order` 解码与 `scale`/`offset` 缩放。
- **实时推送**：WebSocket `ws://<host>:8080/iscs/data` 批量推送（默认 100ms）、连接快照、按变量订阅过滤、控制写点。
- **报警与 SOE**：规则（高/低/等于/不等于/变位）、级别、分组、滞回、确认延时；报警发生记录 + 明细事件 + SOE 持久化到 SQLite，90/30 天保留策略。
- **双机热备（节点级）**：静态角色 + HTTP 心跳 + 数据健康上报 + 自动回切，备机只同步点值、拒绝 WS 连接。
- **实例级主备**：单机内 1 主 + 0..N 备按 `priority` 接管，切换不改变前端绑定。
- **管理与工程 API**：插件/点位 CRUD、Excel 点位导入导出、实时监控、报警/SOE 查询、冗余配置与状态、JWT 登录、`.hmi.zip` 工程存储（版本乐观锁 + 审计日志）。

### 管理 Web UI

运行总览、协议插件、点位配置、实时监控、报警监控、报警规则、冗余配置、冗余监控 8 个页面；支持明暗主题与离线运行（依赖全部本地打包）。

## 目录结构

```
.
├── src/                    # 组态编辑器（React 前端）
│   ├── core/               # 框架无关核心引擎（图元/场景/变量/绑定/IO/工程/报警等）
│   ├── editor/             # React 组件（画布、工具栏、检查器、面板、对话框）
│   └── store/editorStore.ts  # Zustand 全局状态中枢
├── io-backend/             # Rust/WASM I/O 后端
│   ├── crates/             # Cargo workspace 全部 crate（含插件与测试服务器）
│   ├── plugins/            # 编译产物（modbus_tcp.wasm / opc_ua.wasm / iec104.wasm）
│   ├── wit/hmi-plugin.wit  # WASM 插件契约
│   ├── web-ui/             # 管理 Web UI（React/Ant Design）
│   └── config.yaml         # 默认运行配置（首启迁移进 hmi_io.db）
├── scripts/                # dev.ps1 / build.ps1 一键脚本
├── docs/                   # 领域术语（CONTEXT.md）、ADR、规格与计划
├── ARCHITECTURE.md         # 系统架构说明
└── CONTEXT.md              # 领域统一语言
```

## 快速开始

### 前置条件

- Node.js 20+（含 npm）
- Rust stable，并安装 `wasm32-wasip2` 目标：`rustup target add wasm32-wasip2`
- Windows PowerShell（仓库提供 `.ps1` 脚本）

### 安装与构建

```powershell
# 1. 安装前端依赖
npm install
cd io-backend/web-ui
npm install
cd ../..

# 2. 一键构建 WASM 插件 + Rust 后端 + 管理 UI（-Release 使用 release profile）
.\scripts\build.ps1 -Release

# 只构建某一部分
.\scripts\build.ps1 -Release -PluginsOnly   # 仅 WASM 插件
.\scripts\build.ps1 -Release -BackendOnly   # 仅 Rust 后端
```

### 运行

```powershell
# 一键启动：编辑器（Vite :5173）+ 后端（WS :8080 / Web UI :8081）两个窗口
.\scripts\dev.ps1

# 或手动分开启动
npm run dev                     # 组态编辑器 http://localhost:5173
cd io-backend
cargo run -- config.yaml        # WebSocket ws://localhost:8080/iscs/data
                                # 管理 UI http://localhost:8081
```

首次启动后端时：

1. 将 `io-backend/config.yaml` 迁移进 SQLite `io-backend/hmi_io.db`，此后配置以数据库为准（删除 `hmi_io.db` 可重新迁移）。
2. 用户表为空时自动创建 `admin` 用户并生成随机初始密码（打印在启动日志中，首次登录强制改密）。
3. 未设置 `HMI_JWT_SECRET` 时自动生成并持久化 `jwt_secret`。
4. 扫描 `plugins/` 加载 WASM 插件并连接配置的协议实例；双机冗余且本机为 Standby 时不启动插件。

管理 UI 需先构建 `io-backend/web-ui/dist`（`build.ps1` 默认包含，或 `cd io-backend/web-ui && npm run build`），否则 :8081 只有 API 没有页面。

## 配置

运行配置集中在 `io-backend/config.yaml`：

- `server`：WS 监听 `host`/`port`/`path`、管理端口 `web_port`、工程目录 `project_dir`、推送批量间隔 `batch_interval_ms`。
- `plugins`：插件目录、扫描间隔、实例列表（`wasm_file`、协议 `config`、`points` 点表、实例级冗余 `redundancy_group`/`redundancy_role`/`priority`）。
- `alarm`：报警/SOE 保留天数与初始规则。
- `redundancy`：节点级双机热备（`enabled`、`node_id`、`role`、`peer_url`、`peer_ws_port`、心跳/切换/回切/快照等参数）。

点位 `data_type` 支持 `bool`/`int16`/`uint16`/`int32`/`uint32`/`float32`；Modbus 点位额外支持 `byte_order`（`ABCD`/`BADC`/`CDAB`/`DCBA`，host 默认值 `big_endian` 在插件中按 `ABCD` 处理，也可显式书写）。所有插件统一应用 `scale`/`offset`。

详细配置示例见 `io-backend/README.md`。

## 测试

```powershell
# 前端核心逻辑（vitest）
npm test

# 后端单元测试（workspace 默认成员）
cd io-backend
cargo test

# 本地协议仿真器（用于端到端测试，需要单独启动二进制）
cargo build -p iec104-slave -p opcua-server
```

`iec104-slave` 监听 :2404，`opcua-server` 监听 :4840，与 `io-backend/config.yaml` 中的示例实例对应。

## 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：系统架构、数据流、冗余与插件机制
- [CONTEXT.md](CONTEXT.md)：领域统一语言（报警/画面/图元库术语）
- [docs/adr](docs/adr/)：已接受的架构决策记录
- [io-backend/README.md](io-backend/README.md)：后端构建、配置、监控与调试
- [docs/agents](docs/agents/)：仓库 Agent 协作约定

## 许可证

见 [LICENSE](LICENSE)。
