# Repository Guidelines

Contributor guide for HMI Editor, a rail-transit HMI configuration tool with a React/TypeScript frontend and a Rust/WASM I/O backend.

## Project Structure & Module Organization

- Frontend in `src/`: `core/` holds framework-agnostic engines (shapes, scene, variables, bindings, io, alarm, historian, auth, script, report); `editor/` holds React components (canvas, toolbar, panels); `store/editorStore.ts` is the Zustand hub. Entry: `index.html` + `src/main.tsx`; output: `dist/` (gitignored).
- Backend in `io-backend/`: one crate per domain under `io-backend/crates/` (`hmi-io-config`, `hmi-io-db`, `hmi-io-point`, `hmi-io-monitor`, `hmi-io-plugin`, `hmi-io-bridge`, `hmi-io-server`, `hmi-io-web`, plus the `hmi-io-backend` binary crate), compiled plugins in `plugins/`, sources in `crates/plugins/<plugin>/`. All crates belong to one Cargo workspace rooted at `io-backend/Cargo.toml`. Plugins are WASIp2 components built with `wit-bindgen` against the shared contract `io-backend/wit/hmi-plugin.wit` and run on wasmtime 47 (`wasmtime` + `wasmtime-wasi` crates); the host implements the `events` import (log / on-point / on-packet) in `crates/plugin/src/host.rs`. Protocol codecs live in shared crates under `crates/shared/` (`iec104-core`, `ua-core`) and are reused by the plugin guests and by local test servers under `crates/test-servers/` (`iec104-slave` on :2404 and `opcua-server` on :4840, used for end-to-end testing against `config.yaml`). Redundancy engine lives in `crates/point/src/redundancy/` (node-level state machine, heartbeat, value/config sync) and the per-instance group supervisor lives in `crates/plugin/src/registry.rs`.
- Management Web UI in `io-backend/web-ui/`: React/Vite/TypeScript SPA (Ant Design 5, ECharts, react-router), built to `web-ui/dist/` and served by the backend on :8081 (SPA fallback to `index.html`); dev mode proxies `/api` to the backend via Vite on :5174. All deps are bundled (no CDN) so the console works offline. Pages: 运行总览 / 协议插件 / 点位配置 / 实时监控 / 冗余配置 (`/redundancy`) / 冗余监控 (`/redundancy/monitor`).
- `ARCHITECTURE.md` documents the architecture; `config.yaml` files hold runtime configuration.

## Redundancy（主备冗余）

### 节点级双机热备（`redundancy.enabled: true` 时启用）

- 静态角色 `role: primary|backup` + HTTP 心跳（复用 web 端口，`GET /api/redundancy/heartbeat`），备机连续 `failover_threshold` 次心跳失败且对端 WS 端口（`peer_ws_port`）TCP 探测失败后升主。
- 备机为值同步模式：不启动插件、拒绝 WS 连接，Active 节点经 Bridge broadcast 推送点值（`POST /api/redundancy/sync`），并按 `full_snapshot_interval_ms` 补推全量快照；备机用 `PointManager::apply_sync` 写缓存。
- 自动回切：恢复的主机先以 Standby 进入，稳定 `failback_delay_ms` 后**先探测本机数据就绪**（bin 启动插件并轮询连接，最长 8s），成功才发起 claim（`POST /api/redundancy/claim`，请求体含 `role`），避免主备均不健康时反复横跳。
- 采集健康触发：心跳正常但对端上报 `data_healthy=false`（没有任何插件 connected 且最近 3 个扫描周期有成功扫描）连续 `plugin_unhealthy_threshold` 次 → 备机 claim 接管；受 `plugin_promotion_cooldown_ms` 冷却限制。
- 配置快照同步：Active 节点在插件/点位/冗余配置变更后递增 `config_version` 并推送 `POST /api/redundancy/config/push`，备机事务性替换本地 DB（`Repo::apply_config_snapshot`）。
- 端口：`server.web_port`（默认 8081）随 YAML 迁移持久化；双机部署两机配置一致（`role`、`node_id`、`peer_url`、`peer_ws_port` 按机设置）。
- WS 行为：Standby 拒绝新连接；Active 降级时广播 `{"type":"role","state":"standby"}`，WS 服务端收到后断开全部客户端。

### 实例级冗余（单机内 1 主 + 0..N 备，独立于节点级开关）

- 插件实例通过 `redundancy_group` + `redundancy_role(primary|backup)` + `priority` 成组；每组恰好 1 个 primary，backup 按 `priority` 升序接管（全失败后环形回 primary）。
- HMI 逻辑变量 ID = `组名:变量名`；`PointManager` 只广播当前活跃成员的值（非活跃成员数据丢弃），切换不改变前端绑定；写命令经 `registry.write_point` 路由到活跃成员。
- `registry.rs` 的实例组监督器每扫描周期检查活跃成员健康（connected 且扫描新鲜），连续 `instance_failover_threshold` 次失败且过 `instance_switch_cooldown_ms` 后切换；`instance_failback_enabled` 时按 `instance_failback_delay_ms` 探测 primary 并回切。
- `GET /api/redundancy/instance-groups` 返回组状态；`/api/points` 默认只返回 primary/独立实例点位（`?include_backup=true` 返回全部）。

### 前端

- HMI 编辑器 `WebSocketClient` 支持 `urls: string[]`（主在前），断线按序快速轮询；`ConnectionPanel` 的 IO 后端区块可配置主备 WS 与备用 REST API 地址。

### 数据库

- `plugins` 表新增可空列 `redundancy_group TEXT`、`redundancy_role TEXT`、`priority INTEGER`（幂等 `ALTER TABLE` 迁移）；`server_config` 新增 `redundancy_config`、`config_version` 键。

## Build, Test, and Development Commands

Frontend (repo root):

- `npm install` — install dependencies
- `npm run dev` — Vite dev server with hot reload
- `npm run build` — type-check (`tsc -b`) then build (`vite build`)
- `npm run format` — format with Prettier (not yet a devDependency; install separately)

Management Web UI (io-backend/web-ui, React/Vite/Ant Design, served by the backend from `web-ui/dist`):

- `npm install` — install dependencies
- `npm run dev` — Vite dev server on :5174, proxies `/api` to the backend on :8081
- `npm run build` — type-check then build to `dist/` (consumed by `cargo run`)

Full stack:

- `.\scripts\dev.ps1` — one-command dev startup: opens the frontend (Vite :5173) and the backend (`cargo run -- config.yaml` in `io-backend/`) in two separate terminal windows; `-SkipFrontend` / `-SkipBackend` launch only one side

Backend (from repo root unless noted):

- `.\scripts\build.ps1 -Release` — build WASM plugins (target `wasm32-wasip2`), the Rust binary and the Web UI (`web-ui/dist`); `-PluginsOnly` / `-BackendOnly` / `-SkipFrontend` split the steps
- `cargo run -- config.yaml` (in `io-backend/`) — start the backend (WebSocket :8080, web API + management UI :8081); first start migrates `config.yaml` into SQLite `hmi_io.db`; the management UI at `http://localhost:8081` requires `web-ui/dist` built first
- `cargo test` (in `io-backend/`) — run backend unit tests
- `cargo test -p <plugin>` (e.g. `cargo test -p modbus-tcp-plugin`) — run plugin unit tests (e.g. encode/decode helpers in modbus-tcp)
- `cargo build -p iec104-slave -p opcua-server` (in `io-backend/`) — build/run the local IEC 60870-5-104 slave (:2404) and OPC UA server (:4840) simulators; start each binary manually for E2E tests against the backend

### Rust builds inside the Codex sandbox

本机的 `cargo` 是 rustup 代理且没有默认 toolchain，全局 Cargo 配置（`E:\packages\cargo\config.toml`）又把 `build-dir` 指向沙箱不可写的 `E:\packages\rust-targets`，所以沙箱内 `cargo build` 会报 `failed to open: ...\.cargo-build-lock`（拒绝访问）和 `attempt to write a readonly database`（后者只是警告，可忽略）。按以下步骤构建：

1. 指向真实工具链：`$env:RUSTUP_HOME = "E:\packages\cargo\Related Directories\.rustup"`（stable toolchain 装在这里）。
2. 不要改全局配置。临时创建 `io-backend/.cargo/config.toml`，把 `target-dir` 和 `build-dir` **同时**指到可写临时目录（cargo 1.9x 用 `build-dir` 放 `.cargo-build-lock`，且沙箱禁止在工作区内创建该文件）：

   ```toml
   [build]
   target-dir = "C:/Users/huangcheng/AppData/Local/Temp/hmi-cargo-build"
   build-dir = "C:/Users/huangcheng/AppData/Local/Temp/hmi-cargo-build"
   ```

3. 在 `io-backend/` 下执行 `cargo build --target wasm32-wasip2 -p <plugin>` 或 `cargo build -p hmi-io-backend`（`cargo test` 同理）。
4. 把产物拷回工作区：覆盖 `plugins/*.wasm` 可以直接写；`target/debug/hmi-io-backend.exe` 被沙箱写保护，拷成新文件名（如 `hmi-io-backend-fixed.exe`），测试时用 `HMI_BACKEND` 环境变量指向它，或让用户自己在普通终端跑 `.\scripts\build.ps1 -BackendOnly` 刷新正式二进制。
5. 构建成功后删除临时 `io-backend/.cargo/config.toml`，恢复机器默认配置。

完成标准：`cargo build` 退出码为 0 且产物已就位。普通（非沙箱）终端里 `.\scripts\build.ps1` 无需任何变通。

## WASM Plugin Contract

- Single source of truth: `io-backend/wit/hmi-plugin.wit` — package `hmi:plugin`, exports `lifecycle` (init/connect/disconnect/scan-points/write-point/get-name/get-status), imports `events` (log/on-point/on-packet); all functions are `async`.
- Guests (`crates/plugins/<plugin>/`): `wit_bindgen::generate!({ world: "hmi-plugin", path: "../../../wit" })`, implement `crate::exports::hmi::plugin::lifecycle::Guest` (methods have no `&self`), `export!(Plugin)`, and `await` the `hmi::plugin::events` imports directly inside the async exports.
- Host (`crates/plugin/`): `bindgen!({ world: "hmi-plugin", path: "../../wit" })`; store data must implement `wasmtime::component::HasData` plus `events::Host` and `events::HostWithStore` (async import methods take `&Accessor<T, D>` and return `impl Future<Output = ()>`); link with `wasmtime_wasi::p2::add_to_linker_async` and `HmiPlugin::add_to_linker::<S, S>`, instantiate with `HmiPlugin::instantiate_async`, call exports via `store.run_concurrent(...)`. Generated export instance type: `exports::hmi::plugin::lifecycle::Guest`.
- Config requirements: `config.concurrency_support(true)` (not `async_support`), WasiCtx built with `.inherit_network()` (TCP connect fails with "Permission denied" without it).
- Guests get no host network API: they use `std::net::TcpStream` directly (host_tcp_* APIs from the old Extism era no longer exist). `modbus-tcp` delegates protocol framing to the `modbus` crate (v1.1, `tcp::Transport`); `opc-ua` and `iec104` build their own protocol frames over `TcpStream`, reusing shared codecs from `crates/shared/` (`ua-core` all-little-endian, 1601-epoch DateTime, `iec104-core` ASDU/frame codecs).
- The host auto-reconnects a plugin whose `scan_points` returns a non-zero code (link loss): `io-backend/crates/plugin/src/registry.rs` calls `connect()` again, rate-limited to one attempt per 5 s (`RECONNECT_MIN_INTERVAL`). Plugin `connect()` implementations must be re-entrant: reset sequence counters, clear stale sockets/buffers, preserve configured points, and set `connected = false` on every failure path.
- `iec104` plugin behavior: connect sends STARTDT and waits for STARTDT_CON (replying TESTFR meanwhile), then C_IC_NA_1 general interrogation; `scan_points` drains buffered frames (S-frame acks every batch), re-syncs clock (C_CS_NA_1) + re-interrogates every 120 scans, sends TESTFR after 35 s idle and drops the link after 70 s; commands (C_SC_NA_1 / C_SE_NC_1) track ACT_CON with 30 s stale-forgiveness. `opc-ua` plugin: HEL/ACK -> OPN -> CreateSession -> ActivateSession (anonymous or user/pass), per-scan batched ReadRequest drained until the ReadResponse, WriteRequest for control, CloseSession + CloseSecureChannel on disconnect.
- `modbus-tcp` point decoding honors per-point config fields: `data_type` (`bool`/`int16`/`uint16`/`int32`/`uint32`/`float32`, default `uint16`) and `byte_order` (`ABCD`/`BADC`/`CDAB`/`DCBA`, default `ABCD`), then applies `scale`/`offset`. The same fields exist on the host as `PointMapping` (`io-backend/crates/config/src/lib.rs`) and in the plugin as `Pc`.

## Coding Style & Naming Conventions

- TypeScript/React: 2-space indent, double quotes, semicolons, strict mode; format with Prettier.
- PascalCase components/classes (`EditorCanvas`, `ShapeBase`); camelCase functions/variables (`hitTest`, `editorStore`); shared types in per-module `types.ts`; import via `@/` alias.
- `src/core/` must never import React; keep engines framework-independent.
- Rust: rustfmt defaults (4-space indent, `snake_case`), `///` doc comments, one module per folder with `mod.rs`.

## Testing Guidelines

- Backend: `#[cfg(test)]` modules colocated with code (e.g. `src/point/manager.rs`); run with `cargo test`.
- Frontend: no test runner yet; keep logic in `src/core/` as plain TypeScript so tests can be added without a DOM.

## Commit & Pull Request Guidelines

- Short, imperative, capitalized summaries ("Fix binding refresh and panel state sync"); scoped `fix:`/`feat:` prefixes acceptable; bullet-list body explains what and why.
- Keep PRs focused, describe intent and testing, add screenshots for UI changes. No CI or templates exist yet.

## Security & Configuration Tips

- `config.yaml` controls ports, plugin instances, and point mappings; keep secrets out.
- Redundancy uses `redundancy:` block: `enabled / node_id / role / peer_url / peer_ws_port / heartbeat_interval_ms / failover_threshold / failback_delay_ms / full_snapshot_interval_ms / plugin_unhealthy_threshold / plugin_promotion_cooldown_ms / instance_failover_threshold / instance_failback_enabled / instance_failback_delay_ms / instance_switch_cooldown_ms`；`server.web_port` 控制管理端口。
- Never commit `hmi_io.db` (local SQLite). Load `.wasm` plugins only from `plugins/`; treat plugin binaries as untrusted code.

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues, accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
