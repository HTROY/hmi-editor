# io-backend crate 结构重组设计

日期：2026-08-01

## 背景与目标

当前 `io-backend/` 的 Cargo 组织存在三个互不相干的上下文：

- `io-backend/` 是单体 crate `hmi-io-backend`，bridge、db、monitor、plugin、point、server、web 全部作为模块放在一个包里；
- `plugins-src/` 不是 workspace，3 个插件 + 2 个共享 codec crate 各自独立，各有自己的 `Cargo.lock`；
- `test-servers/` 是另一个独立 workspace，通过相对路径引用共享 crate。

重组目标：

1. 把所有 crate 收进**单一 Cargo workspace**（一个 lockfile、一个 `target/`）；
2. 把后端单体按现有模块域拆成**独立 crate**；
3. 全部源码统一收进 `io-backend/crates/`；
4. 同步更新构建脚本与文档，保证现有命令和运行时行为不变。

## 目标布局

```
io-backend/
├── Cargo.toml                  # [workspace] 根（resolver = "2"）
├── Cargo.lock                  # 统一 lockfile（删除旧 6 个分散 lockfile）
├── target/                     # 统一构建缓存（含 wasm32-wasip2 产物）
├── wit/hmi-plugin.wit          # 插件契约，位置不变
├── config.yaml                 # 运行时配置，位置不变
├── plugins/                    # .wasm 输出目录，位置不变
├── web-ui/                     # 管理 UI，完全不动
└── crates/
    ├── bin/                    # hmi-io-backend（二进制入口）
    ├── config/                 # hmi-io-config
    ├── db/                     # hmi-io-db
    ├── point/                  # hmi-io-point
    ├── monitor/                # hmi-io-monitor
    ├── plugin/                 # hmi-io-plugin（WASM 宿主）
    ├── bridge/                 # hmi-io-bridge
    ├── server/                 # hmi-io-server（WebSocket）
    ├── web/                    # hmi-io-web
    ├── plugins/
    │   ├── modbus-tcp/         # modbus-tcp-plugin
    │   ├── opc-ua/             # opc-ua-plugin
    │   └── iec104/             # iec104-plugin
    ├── shared/
    │   ├── iec104-core/
    │   └── ua-core/
    ├── test-servers/
    │   ├── iec104-slave/
    │   └── opcua-server/
    └── plugins/config.yaml     # 原 plugins-src/config.yaml 样例配置
```

## Workspace 配置

- `[workspace] members` 包含全部 16 个 crate；
- `default-members` 只列 9 个主机 crate（bin、config、db、point、monitor、plugin、bridge、server、web），保证 `cargo run -- config.yaml` / `cargo build` 不顺手编译插件和测试服务；
- `[workspace.package]` 统一 `version = "0.3.0"`、`edition = "2021"`；
- 公共第三方依赖进 `[workspace.dependencies]`（tokio、serde、serde_json、serde_yaml、anyhow、thiserror、log、env_logger、wasmtime、wasmtime-wasi、wit-bindgen、rusqlite、axum、tower-http、tokio-tungstenite、futures-util、calamine、rust_xlsxwriter 等），各 crate 用 `workspace = true` 引用；
- 主机 crate 之间的路径依赖也集中声明在 `workspace.dependencies`（如 `hmi-io-point = { path = "../point" }`）；
- 插件 wasm 产物统一为 `io-backend/target/wasm32-wasip2/{debug|release}/<name>_plugin.wasm`；
- 删除并移除版本控制：`plugins-src` 下 5 个与 `test-servers` 下 1 个旧 `Cargo.lock`，根 `io-backend/Cargo.lock` 继续入库（与现有约定一致）；
- `.gitignore` 中过时的 `io-backend/plugins-src/*/target/` 条目删除（不再有该路径），`io-backend/target/` 保留。

## crate 边界与依赖

沿用现有模块划分，`crate::` 引用改为跨 crate 引用；跨 crate 使用的类型保持 `pub`，每个 crate 在 `lib.rs` 做必要的 `pub mod` / 再导出。

| crate（目录）                      | 内容                                                           | 内部路径依赖                                               |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `hmi-io-db`（crates/db）           | Repo、schema                                                   | —                                                          |
| `hmi-io-config`（crates/config）   | AppConfig、ServerConfig、PointMapping、配置迁移                | hmi-io-db                                                  |
| `hmi-io-point`（crates/point）     | PointManager、PointValue、WsDataMessage、WsConfigChangeMessage | hmi-io-config                                              |
| `hmi-io-monitor`（crates/monitor） | MonitorCollector、监控类型                                     | hmi-io-point                                               |
| `hmi-io-plugin`（crates/plugin）   | host、interface、registry（WASM 宿主）                         | hmi-io-config、hmi-io-monitor、hmi-io-point                |
| `hmi-io-bridge`（crates/bridge）   | Bridge（插件回调 → 点位聚合/广播）                             | hmi-io-point                                               |
| `hmi-io-server`（crates/server）   | WebSocket 服务                                                 | hmi-io-config、hmi-io-monitor、hmi-io-plugin、hmi-io-point |
| `hmi-io-web`（crates/web）         | Axum API、管理 UI 托管、Excel 导入导出                         | hmi-io-db、hmi-io-monitor、hmi-io-plugin、hmi-io-point     |
| `hmi-io-backend`（crates/bin）     | main.rs 组装与启动                                             | 以上全部主机 crate                                         |

依赖图（内部路径依赖，无环）：

```
db ← config ← point ← monitor ← plugin ← server
                        └ bridge
        db ← web ← plugin / monitor / point
bin → 全部主机 crate
```

文件映射（`git mv` 保留历史）：

- `src/config.rs` → `crates/config/src/lib.rs`（单文件 crate）
- `src/db/{mod,repo,schema}.rs` → `crates/db/src/{lib,repo,schema}.rs`
- `src/point/{mod,manager,types}.rs` → `crates/point/src/{lib,manager,types}.rs`
- `src/monitor/{mod,collector,types}.rs` → `crates/monitor/src/{lib,collector,types}.rs`
- `src/plugin/{mod,host,interface,registry}.rs` → `crates/plugin/src/{lib,host,interface,registry}.rs`
- `src/bridge/{mod,bridge}.rs` → `crates/bridge/src/{lib,bridge}.rs`
- `src/server/{mod,ws}.rs` → `crates/server/src/{lib,ws}.rs`
- `src/web/{mod,api,server}.rs` → `crates/web/src/{lib,api,server}.rs`
- `src/main.rs` → `crates/bin/src/main.rs`
- `plugins-src/{modbus-tcp,opc-ua,iec104}/` → `crates/plugins/...`
- `plugins-src/shared/{iec104-core,ua-core}/` → `crates/shared/...`
- `test-servers/{iec104-slave,opcua-server}/` → `crates/test-servers/...`
- `plugins-src/config.yaml` → `crates/plugins/config.yaml`（样例配置，无运行时引用）

第三方依赖按实际 `use` 分配到对应 crate，不携带未用依赖；`calamine` / `rust_xlsxwriter` 只进 `hmi-io-web`；`serde_yaml` 进 `hmi-io-config` 与 `hmi-io-backend`（bin 有配置导出逻辑）。

### wit 引用路径

- 宿主 `hmi-io-plugin`：`bindgen!({ path: "../../wit" })`（原 `"wit"`）；
- 三个插件 guest：`wit_bindgen::generate!({ path: "../../../wit" })`（原 `"../../wit"`）；
- 插件引用共享 crate：`path = "../../shared/iec104-core"` 等（原 `"../shared/..."`）；
- 测试服务引用共享 crate：`path = "../shared/iec104-core"` 等（原 `"../plugins-src/shared/..."`）。

## 脚本与文档更新

### scripts/build.ps1

- 插件构建：在 `io-backend/`（workspace 根）执行 `cargo build -p modbus-tcp-plugin -p opc-ua-plugin -p iec104-plugin --target wasm32-wasip2 [--release]`；
- wasm 复制源：`target/wasm32-wasip2/{debug|release}/<name>_plugin.wasm`（统一 target，不再按插件目录找）；
- 后端构建：`cargo build [--release]`（默认成员）不变，二进制路径 `target/release/hmi-io-backend.exe` 不变；
- `plugins/` 输出目录与产物文件名不变。

### scripts/dev.ps1

无需功能改动（`cargo run -- config.yaml` 行为不变）；核对提示文本中的路径描述。

### 文档

- `io-backend/README.md`：更新架构图、手动构建命令、Guest/Host 路径、目录结构章节；
- `AGENTS.md`：更新「Project Structure」小节、后端/插件/测试服务命令、wit 路径、`src/plugin/...` 与 `src/config.rs` 等文件路径描述；
- `ARCHITECTURE.md`：已确认无旧路径引用，不做改动（实现时再 grep 一次兜底）；
- 仓库根目录无 `README.md`，无需处理。

## 保持不变的内容（兼容性）

- 可执行文件名 `hmi-io-backend` 与运行命令 `cargo run -- config.yaml`（在 `io-backend/` 下）；
- `config.yaml`、`hmi_io.db` 的读写行为与位置；
- `plugins/` 输出目录与 `modbus_tcp.wasm` / `opc_ua.wasm` / `iec104.wasm` 文件名；
- `wit/hmi-plugin.wit` 契约内容、插件 package/版本；
- WebSocket :8080 与 Web UI/API :8081 端口、路径；
- `web-ui/` 与前端代码完全不动；
- 各模块业务逻辑、协议行为、配置结构不变。

## 验证清单

全部通过才算完成：

1. `cargo build`（默认 9 个主机 crate）成功；
2. `cargo test`（主机 crate 单测）成功；
3. `cargo test --workspace` 成功（含插件与测试服务 crate 的单测）；
4. `cargo build --target wasm32-wasip2 -p modbus-tcp-plugin -p opc-ua-plugin -p iec104-plugin --release` 成功，产物可复制到 `plugins/`；
5. `cargo build -p iec104-slave -p opcua-server` 成功；
6. `.\scripts\build.ps1 -Release` 端到端成功（插件 + 后端 + web-ui）；
7. `cargo run -- config.yaml` 冒烟启动：WS :8080、API :8081 正常；
8. 全文检索确认没有残留 `plugins-src`、`io-backend/src/`、`test-servers/` 旧路径（历史提交除外）；
9. 旧分散 `Cargo.lock` 已从版本控制移除，根 `Cargo.lock` 覆盖全部 workspace 成员。

## 非目标

- 不重构业务逻辑、不改协议行为、不调整配置结构；
- 不为插件引入独立的 target 目录或嵌套 workspace；
- 不新增 CI、不引入新的第三方依赖；
- 不移动 `web-ui/`、`wit/`、`plugins/`、`config.yaml` 的位置。
