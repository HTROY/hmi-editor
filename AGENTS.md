# Repository Guidelines

Contributor guide for HMI Editor, a rail-transit HMI configuration tool with a React/TypeScript frontend and a Rust/WASM I/O backend.

## Project Structure & Module Organization

- Frontend in `src/`: `core/` holds framework-agnostic engines (shapes, scene, variables, bindings, io, alarm, historian, auth, script, report); `editor/` holds React components (canvas, toolbar, panels); `store/editorStore.ts` is the Zustand hub. Entry: `index.html` + `src/main.tsx`; output: `dist/` (gitignored).
- Backend in `io-backend/`: Rust modules in `src/` (bridge, db, monitor, plugin, point, server, web), compiled plugins in `plugins/`, sources in `plugins-src/<plugin>/`. Plugins are WASIp2 components built with `wit-bindgen` against the shared contract `io-backend/wit/hmi-plugin.wit` and run on wasmtime 47 (`wasmtime` + `wasmtime-wasi` crates); the host implements the `events` import (log / on-point / on-packet) in `src/plugin/host.rs`. Protocol codecs live in shared crates under `plugins-src/shared/` (`iec104-core`, `ua-core`) and are reused by the plugin guests and by local test servers under `io-backend/test-servers/` (a standalone Cargo workspace with `iec104-slave` on :2404 and `opcua-server` on :4840, used for end-to-end testing against `config.yaml`).
- Management Web UI in `io-backend/web-ui/`: React/Vite/TypeScript SPA (Ant Design 5, ECharts, react-router), built to `web-ui/dist/` and served by the backend on :8081 (SPA fallback to `index.html`); dev mode proxies `/api` to the backend via Vite on :5174. All deps are bundled (no CDN) so the console works offline.
- `ARCHITECTURE.md` documents the architecture; `config.yaml` files hold runtime configuration.

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
- `cargo test` (in `plugins-src/<plugin>/`) — run plugin unit tests (e.g. encode/decode helpers in modbus-tcp)
- `cargo build`/`cargo test` (in `io-backend/test-servers/`) — build/run the local IEC 60870-5-104 slave (:2404) and OPC UA server (:4840) simulators; start each binary manually for E2E tests against the backend

## WASM Plugin Contract

- Single source of truth: `io-backend/wit/hmi-plugin.wit` — package `hmi:plugin`, exports `lifecycle` (init/connect/disconnect/scan-points/write-point/get-name/get-status), imports `events` (log/on-point/on-packet); all functions are `async`.
- Guests (`plugins-src/<plugin>/`): `wit_bindgen::generate!({ world: "hmi-plugin", path: "../../wit" })`, implement `crate::exports::hmi::plugin::lifecycle::Guest` (methods have no `&self`), `export!(Plugin)`, and `await` the `hmi::plugin::events` imports directly inside the async exports.
- Host (`io-backend/src/plugin/`): `bindgen!({ world: "hmi-plugin", path: "wit" })`; store data must implement `wasmtime::component::HasData` plus `events::Host` and `events::HostWithStore` (async import methods take `&Accessor<T, D>` and return `impl Future<Output = ()>`); link with `wasmtime_wasi::p2::add_to_linker_async` and `HmiPlugin::add_to_linker::<S, S>`, instantiate with `HmiPlugin::instantiate_async`, call exports via `store.run_concurrent(...)`. Generated export instance type: `exports::hmi::plugin::lifecycle::Guest`.
- Config requirements: `config.concurrency_support(true)` (not `async_support`), WasiCtx built with `.inherit_network()` (TCP connect fails with "Permission denied" without it).
- Guests get no host network API: they use `std::net::TcpStream` directly (host_tcp_* APIs from the old Extism era no longer exist). `modbus-tcp` delegates protocol framing to the `modbus` crate (v1.1, `tcp::Transport`); `opc-ua` and `iec104` build their own protocol frames over `TcpStream`, reusing shared codecs from `plugins-src/shared/` (`ua-core` all-little-endian, 1601-epoch DateTime, `iec104-core` ASDU/frame codecs).
- The host auto-reconnects a plugin whose `scan_points` returns a non-zero code (link loss): `io-backend/src/plugin/registry.rs` calls `connect()` again, rate-limited to one attempt per 5 s (`RECONNECT_MIN_INTERVAL`). Plugin `connect()` implementations must be re-entrant: reset sequence counters, clear stale sockets/buffers, preserve configured points, and set `connected = false` on every failure path.
- `iec104` plugin behavior: connect sends STARTDT and waits for STARTDT_CON (replying TESTFR meanwhile), then C_IC_NA_1 general interrogation; `scan_points` drains buffered frames (S-frame acks every batch), re-syncs clock (C_CS_NA_1) + re-interrogates every 120 scans, sends TESTFR after 35 s idle and drops the link after 70 s; commands (C_SC_NA_1 / C_SE_NC_1) track ACT_CON with 30 s stale-forgiveness. `opc-ua` plugin: HEL/ACK -> OPN -> CreateSession -> ActivateSession (anonymous or user/pass), per-scan batched ReadRequest drained until the ReadResponse, WriteRequest for control, CloseSession + CloseSecureChannel on disconnect.
- `modbus-tcp` point decoding honors per-point config fields: `data_type` (`bool`/`int16`/`uint16`/`int32`/`uint32`/`float32`, default `uint16`) and `byte_order` (`ABCD`/`BADC`/`CDAB`/`DCBA`, default `ABCD`), then applies `scale`/`offset`. The same fields exist on the host as `PointMapping` (`io-backend/src/config.rs`) and in the plugin as `Pc`.

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
- Never commit `hmi_io.db` (local SQLite). Load `.wasm` plugins only from `plugins/`; treat plugin binaries as untrusted code.
