# io-backend Crate Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `io-backend/` into a single Cargo workspace with 16 members, split the monolithic backend into 9 domain crates, and keep all runtime behavior, commands, and artifact paths intact.

**Architecture:** A virtual workspace rooted at `io-backend/Cargo.toml` unifies the host crates (`crates/{bin,config,db,point,monitor,plugin,bridge,server,web}`), WASM plugin crates (`crates/plugins/*`), shared protocol codecs (`crates/shared/*`), and test servers (`crates/test-servers/*`). `default-members` covers only the 9 host crates so `cargo run -- config.yaml` and `cargo build` behave as before; plugins are built explicitly with `-p <plugin> --target wasm32-wasip2`. Code is moved with `git mv` so history is preserved; only import paths (`crate::` → cross-crate names) and wit/path references change.

**Tech Stack:** Rust 2021, Cargo workspace (resolver 2), wasmtime 47 + wasmtime-wasi 47, wit-bindgen 0.58, tokio 1, axum 0.8, rusqlite 0.34, PowerShell build scripts.

**Spec:** `docs/superpowers/specs/2026-08-01-io-backend-crate-restructure-design.md`

---

## Environment Notes (this machine)

- `CARGO_HOME=E:\packages\cargo` config sets `[build] build-dir = "E:\packages\rust-targets"`. All cargo artifacts (native and wasm) land in `E:\packages\rust-targets`, NOT `io-backend/target`. Adjust artifact-path checks accordingly (e.g. `E:\packages\rust-targets\wasm32-wasip2\release\<crate>_plugin.wasm`).
- `scripts/build.ps1` must resolve the cargo target directory dynamically from `cargo metadata --format-version 1` (field `target_directory`) instead of hardcoding `io-backend/target` (see Task 4).
- Cargo commands write outside the sandbox; run them with escalated permissions (the `["cargo"]` prefix rule is already approved).
- Node.js is managed by fnm: `E:\packages\fnm\node-versions\v24.16.0\installation\npm.cmd` (add the installation dir to `$env:PATH` before invoking npm). `node_modules` for the repo root and `io-backend/web-ui` were copied from the main checkout; no network npm install is needed.
- Git commits require escalated permissions in this environment.

---

## File Structure

New/changed files (all paths relative to repo root unless noted):

```
io-backend/Cargo.toml                       # REPLACE: package → virtual workspace
io-backend/.gitignore                       # MODIFY: remove stale plugins-src target line
io-backend/crates/bin/Cargo.toml            # ADD
io-backend/crates/bin/src/main.rs           # MOVE from io-backend/src/main.rs + import fixes
io-backend/crates/config/Cargo.toml         # ADD
io-backend/crates/config/src/lib.rs         # MOVE from io-backend/src/config.rs + import fix
io-backend/crates/db/Cargo.toml             # ADD
io-backend/crates/db/src/lib.rs             # MOVE from io-backend/src/db/mod.rs
io-backend/crates/db/src/repo.rs            # MOVE (unchanged)
io-backend/crates/db/src/schema.rs          # MOVE (unchanged)
io-backend/crates/point/Cargo.toml          # ADD
io-backend/crates/point/src/lib.rs          # MOVE from io-backend/src/point/mod.rs
io-backend/crates/point/src/manager.rs      # MOVE + import fixes
io-backend/crates/point/src/types.rs        # MOVE (unchanged)
io-backend/crates/monitor/Cargo.toml        # ADD
io-backend/crates/monitor/src/lib.rs        # MOVE from io-backend/src/monitor/mod.rs
io-backend/crates/monitor/src/collector.rs  # MOVE + import fixes
io-backend/crates/monitor/src/types.rs      # MOVE (unchanged)
io-backend/crates/plugin/Cargo.toml         # ADD
io-backend/crates/plugin/src/lib.rs         # MOVE from io-backend/src/plugin/mod.rs
io-backend/crates/plugin/src/host.rs        # MOVE + wit path + import fixes
io-backend/crates/plugin/src/interface.rs   # MOVE (unchanged)
io-backend/crates/plugin/src/registry.rs    # MOVE + import fixes
io-backend/crates/bridge/Cargo.toml         # ADD
io-backend/crates/bridge/src/lib.rs         # MOVE from io-backend/src/bridge/mod.rs
io-backend/crates/bridge/src/bridge.rs      # MOVE + import fixes
io-backend/crates/server/Cargo.toml         # ADD
io-backend/crates/server/src/lib.rs         # MOVE from io-backend/src/server/mod.rs
io-backend/crates/server/src/ws.rs          # MOVE + import fixes
io-backend/crates/web/Cargo.toml            # ADD
io-backend/crates/web/src/lib.rs            # MOVE from io-backend/src/web/mod.rs
io-backend/crates/web/src/api.rs            # MOVE + import fixes
io-backend/crates/web/src/server.rs         # MOVE + import fixes
io-backend/crates/plugins/modbus-tcp/...    # MOVE from io-backend/plugins-src/modbus-tcp
io-backend/crates/plugins/opc-ua/...        # MOVE from io-backend/plugins-src/opc-ua
io-backend/crates/plugins/iec104/...        # MOVE from io-backend/plugins-src/iec104
io-backend/crates/plugins/config.yaml       # MOVE from io-backend/plugins-src/config.yaml
io-backend/crates/shared/iec104-core/...    # MOVE from io-backend/plugins-src/shared/iec104-core
io-backend/crates/shared/ua-core/...        # MOVE from io-backend/plugins-src/shared/ua-core
io-backend/crates/test-servers/iec104-slave/...  # MOVE from io-backend/test-servers/iec104-slave
io-backend/crates/test-servers/opcua-server/...  # MOVE from io-backend/test-servers/opcua-server
io-backend/crates/test-servers/Cargo.toml   # DELETE (old standalone workspace; superseded by root)
io-backend/crates/plugins/*/Cargo.lock      # DELETE (6 old lockfiles)
io-backend/crates/shared/*/Cargo.lock       # DELETE (included above)
scripts/build.ps1                           # MODIFY: plugin build via workspace + unified target
io-backend/README.md                        # MODIFY: paths, commands, directory tree
AGENTS.md                                   # MODIFY: backend section paths and commands
```

Not touched: `io-backend/wit/`, `io-backend/plugins/`, `io-backend/config.yaml`, `io-backend/web-ui/`, `io-backend/hmi_io.db*`, root `ARCHITECTURE.md`, frontend `src/`.

---

## Task 1: Preflight and baseline

**Files:** none

- [ ] **Step 1: Confirm the worktree is clean**

Run (repo root):

```powershell
git status --short
```

Expected: empty output (the spec commit is already in).

- [ ] **Step 2: Confirm the current backend compiles before surgery**

Run:

```powershell
Set-Location io-backend
cargo check
```

Expected: `Finished` with no errors. If this fails, stop and fix the baseline first.

---

## Task 2: Move shared crates, plugin crates, sample config, and test servers

This task keeps everything outside the host compilable on its own (each moved crate still has its own workspace/lockfile); the root workspace conversion happens in Task 3.

**Files:**
- Move: `io-backend/plugins-src/shared/{iec104-core,ua-core}` → `io-backend/crates/shared/`
- Move: `io-backend/plugins-src/{modbus-tcp,opc-ua,iec104}` → `io-backend/crates/plugins/`
- Move: `io-backend/plugins-src/config.yaml` → `io-backend/crates/plugins/config.yaml`
- Move: `io-backend/test-servers` → `io-backend/crates/test-servers`
- Modify: `io-backend/crates/plugins/{modbus-tcp,opc-ua,iec104}/Cargo.toml` (path deps)
- Modify: `io-backend/crates/plugins/{modbus-tcp,opc-ua,iec104}/src/lib.rs` (wit path)
- Modify: `io-backend/crates/test-servers/Cargo.toml` (shared codec paths)

- [ ] **Step 1: Move the shared codec crates**

Run (repo root):

```powershell
New-Item -ItemType Directory -Path io-backend/crates/shared -Force | Out-Null
git mv io-backend/plugins-src/shared/iec104-core io-backend/crates/shared/iec104-core
git mv io-backend/plugins-src/shared/ua-core io-backend/crates/shared/ua-core
```

Expected: `git status` shows the two crates as renamed, staged.

- [ ] **Step 2: Move the three plugin crates and the sample config**

Run:

```powershell
New-Item -ItemType Directory -Path io-backend/crates/plugins -Force | Out-Null
git mv io-backend/plugins-src/modbus-tcp io-backend/crates/plugins/modbus-tcp
git mv io-backend/plugins-src/opc-ua io-backend/crates/plugins/opc-ua
git mv io-backend/plugins-src/iec104 io-backend/crates/plugins/iec104
git mv io-backend/plugins-src/config.yaml io-backend/crates/plugins/config.yaml
```

Expected: all four moves succeed; `plugins-src` is empty afterwards.

- [ ] **Step 3: Move the test-servers directory**

Run:

```powershell
git mv io-backend/test-servers io-backend/crates/test-servers
```

Expected: the whole directory (workspace manifest + two members) moves.

- [ ] **Step 4: Update the three plugin Cargo.toml path dependencies**

`io-backend/crates/plugins/iec104/Cargo.toml` — change this line:

```toml
iec104-core = { path = "../shared/iec104-core" }
```

to:

```toml
iec104-core = { path = "../../../shared/iec104-core" }
```

`io-backend/crates/plugins/opc-ua/Cargo.toml` — change:

```toml
ua-core = { path = "../shared/ua-core" }
```

to:

```toml
ua-core = { path = "../../../shared/ua-core" }
```

`modbus-tcp` has no shared path dependency; its Cargo.toml is unchanged in this task.

- [ ] **Step 5: Update the wit path in the three plugin lib.rs files**

In each of `io-backend/crates/plugins/{modbus-tcp,opc-ua,iec104}/src/lib.rs`, change:

```rust
    path: "../../wit",
```

to:

```rust
    path: "../../../wit",
```

- [ ] **Step 6: Update the test-servers standalone workspace paths**

`io-backend/crates/test-servers/Cargo.toml` — change the two workspace dependency paths:

```toml
iec104-core = { path = "../plugins-src/shared/iec104-core" }
ua-core = { path = "../plugins-src/shared/ua-core" }
```

to:

```toml
iec104-core = { path = "../../shared/iec104-core" }
ua-core = { path = "../../shared/ua-core" }
```

- [ ] **Step 7: Verify the moved standalone crates still build**

Run (each plugin still standalone, from its own directory):

```powershell
Set-Location io-backend/crates/plugins/modbus-tcp
cargo build --target wasm32-wasip2
Set-Location ../opc-ua
cargo build --target wasm32-wasip2
Set-Location ../iec104
cargo build --target wasm32-wasip2
```

Expected: each `Finished` successfully. Then:

```powershell
Set-Location ../../test-servers
cargo build
```

Expected: `iec104-slave` and `opcua-server` build successfully.

- [ ] **Step 8: Commit**

Run (repo root):

```powershell
git add -A
git commit -m "refactor: move plugins, shared codecs and test servers under io-backend/crates"
```

---

## Task 3: Split host modules into crates and convert to one workspace

This is the core task. Complete all steps before running the final build; the tree only compiles once the root workspace manifest exists.

### 3.1 Create `hmi-io-db`

**Files:**
- Move: `io-backend/src/db` → `io-backend/crates/db`
- Add: `io-backend/crates/db/Cargo.toml`

- [ ] **Step 1: Move the module and rename `mod.rs` to `lib.rs`**

Run (repo root):

```powershell
New-Item -ItemType Directory -Path io-backend/crates/db -Force | Out-Null
git mv io-backend/src/db io-backend/crates/db
git mv io-backend/crates/db/src/mod.rs io-backend/crates/db/src/lib.rs
```

- [ ] **Step 2: Add `io-backend/crates/db/Cargo.toml`**

```toml
[package]
name = "hmi-io-db"
version.workspace = true
edition.workspace = true

[dependencies]
rusqlite.workspace = true
serde.workspace = true
anyhow.workspace = true
```

`lib.rs` already contains `pub mod repo; pub mod schema;` and needs no code changes.

### 3.2 Create `hmi-io-config`

**Files:**
- Move: `io-backend/src/config.rs` → `io-backend/crates/config/src/lib.rs`
- Add: `io-backend/crates/config/Cargo.toml`

- [ ] **Step 3: Move the file**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/config/src -Force | Out-Null
git mv io-backend/src/config.rs io-backend/crates/config/src/lib.rs
```

- [ ] **Step 4: Fix the cross-crate import in `io-backend/crates/config/src/lib.rs`**

Change:

```rust
use crate::db::repo::Repo;
```

to:

```rust
use hmi_io_db::repo::Repo;
```

- [ ] **Step 5: Add `io-backend/crates/config/Cargo.toml`**

```toml
[package]
name = "hmi-io-config"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-db.workspace = true
serde.workspace = true
serde_json.workspace = true
serde_yaml.workspace = true
anyhow.workspace = true
log.workspace = true
```

### 3.3 Create `hmi-io-point`

**Files:**
- Move: `io-backend/src/point` → `io-backend/crates/point`
- Add: `io-backend/crates/point/Cargo.toml`

- [ ] **Step 6: Move the module**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/point -Force | Out-Null
git mv io-backend/src/point io-backend/crates/point
git mv io-backend/crates/point/src/mod.rs io-backend/crates/point/src/lib.rs
```

- [ ] **Step 7: Fix imports in `io-backend/crates/point/src/manager.rs`**

Change:

```rust
use crate::config::{AppConfig, PointMapping};
use crate::point::types::PointValue;
```

to:

```rust
use hmi_io_config::{AppConfig, PointMapping};
use crate::types::PointValue;
```

- [ ] **Step 8: Add `io-backend/crates/point/Cargo.toml`**

```toml
[package]
name = "hmi-io-point"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-config.workspace = true
serde.workspace = true
serde_json.workspace = true
log.workspace = true
```

### 3.4 Create `hmi-io-monitor`

**Files:**
- Move: `io-backend/src/monitor` → `io-backend/crates/monitor`
- Add: `io-backend/crates/monitor/Cargo.toml`

- [ ] **Step 9: Move the module**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/monitor -Force | Out-Null
git mv io-backend/src/monitor io-backend/crates/monitor
git mv io-backend/crates/monitor/src/mod.rs io-backend/crates/monitor/src/lib.rs
```

- [ ] **Step 10: Fix imports in `io-backend/crates/monitor/src/collector.rs`**

Change:

```rust
use crate::monitor::types::*;
use crate::point::types::PointValue;
```

to:

```rust
use crate::types::*;
use hmi_io_point::types::PointValue;
```

- [ ] **Step 11: Add `io-backend/crates/monitor/Cargo.toml`**

```toml
[package]
name = "hmi-io-monitor"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-point.workspace = true
serde.workspace = true
serde_json.workspace = true
```

### 3.5 Create `hmi-io-plugin`

**Files:**
- Move: `io-backend/src/plugin` → `io-backend/crates/plugin`
- Add: `io-backend/crates/plugin/Cargo.toml`

- [ ] **Step 12: Move the module**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/plugin -Force | Out-Null
git mv io-backend/src/plugin io-backend/crates/plugin
git mv io-backend/crates/plugin/src/mod.rs io-backend/crates/plugin/src/lib.rs
```

- [ ] **Step 13: Fix imports in `io-backend/crates/plugin/src/host.rs`**

Change:

```rust
use crate::monitor::collector::MonitorCollector;
use crate::point::types::PointValue;
```

to:

```rust
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_point::types::PointValue;
```

Also change the bindgen path:

```rust
    path: "wit",
```

to:

```rust
    path: "../../wit",
```

- [ ] **Step 14: Fix imports in `io-backend/crates/plugin/src/registry.rs`**

Change:

```rust
use crate::config::{AppConfig, PluginInstance as PluginInstanceConfig};
use crate::monitor::collector::MonitorCollector;
use crate::point::types::PointValue;
```

to:

```rust
use hmi_io_config::{AppConfig, PluginInstance as PluginInstanceConfig};
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_point::types::PointValue;
```

`interface.rs` has no cross-crate imports; leave it unchanged.

- [ ] **Step 15: Add `io-backend/crates/plugin/Cargo.toml`**

```toml
[package]
name = "hmi-io-plugin"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-config.workspace = true
hmi-io-monitor.workspace = true
hmi-io-point.workspace = true
wasmtime.workspace = true
wasmtime-wasi.workspace = true
wit-bindgen.workspace = true
tokio.workspace = true
anyhow.workspace = true
log.workspace = true
serde_json.workspace = true
```

### 3.6 Create `hmi-io-bridge`

**Files:**
- Move: `io-backend/src/bridge` → `io-backend/crates/bridge`
- Add: `io-backend/crates/bridge/Cargo.toml`

- [ ] **Step 16: Move the module**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/bridge -Force | Out-Null
git mv io-backend/src/bridge io-backend/crates/bridge
git mv io-backend/crates/bridge/src/mod.rs io-backend/crates/bridge/src/lib.rs
```

- [ ] **Step 17: Fix imports in `io-backend/crates/bridge/src/bridge.rs`**

Change:

```rust
use crate::point::manager::PointManager;
use crate::point::types::{PointValue, WsDataMessage};
```

to:

```rust
use hmi_io_point::manager::PointManager;
use hmi_io_point::types::{PointValue, WsDataMessage};
```

- [ ] **Step 18: Add `io-backend/crates/bridge/Cargo.toml`**

```toml
[package]
name = "hmi-io-bridge"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-point.workspace = true
tokio.workspace = true
serde_json.workspace = true
log.workspace = true
```

### 3.7 Create `hmi-io-server`

**Files:**
- Move: `io-backend/src/server` → `io-backend/crates/server`
- Add: `io-backend/crates/server/Cargo.toml`

- [ ] **Step 19: Move the module**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/server -Force | Out-Null
git mv io-backend/src/server io-backend/crates/server
git mv io-backend/crates/server/src/mod.rs io-backend/crates/server/src/lib.rs
```

- [ ] **Step 20: Fix imports in `io-backend/crates/server/src/ws.rs`**

Change:

```rust
use crate::config::ServerConfig;
use crate::monitor::collector::MonitorCollector;
use crate::plugin::registry::PluginRegistry;
use crate::point::manager::PointManager;
use crate::point::types::{PointValue, WsDataMessage};
```

to:

```rust
use hmi_io_config::ServerConfig;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
use hmi_io_point::types::{PointValue, WsDataMessage};
```

- [ ] **Step 21: Add `io-backend/crates/server/Cargo.toml`**

```toml
[package]
name = "hmi-io-server"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-config.workspace = true
hmi-io-monitor.workspace = true
hmi-io-plugin.workspace = true
hmi-io-point.workspace = true
futures-util.workspace = true
tokio.workspace = true
tokio-tungstenite.workspace = true
anyhow.workspace = true
log.workspace = true
serde_json.workspace = true
```

### 3.8 Create `hmi-io-web`

**Files:**
- Move: `io-backend/src/web` → `io-backend/crates/web`
- Add: `io-backend/crates/web/Cargo.toml`

- [ ] **Step 22: Move the module**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/web -Force | Out-Null
git mv io-backend/src/web io-backend/crates/web
git mv io-backend/crates/web/src/mod.rs io-backend/crates/web/src/lib.rs
```

- [ ] **Step 23: Fix imports in `io-backend/crates/web/src/api.rs`**

Change:

```rust
use crate::db::repo::{PluginRow, PointRow, Repo};
use crate::monitor::collector::MonitorCollector;
use crate::monitor::types::*;
use crate::point::manager::PointManager;
use crate::point::types::WsConfigChangeMessage;
```

to:

```rust
use hmi_io_db::repo::{PluginRow, PointRow, Repo};
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_monitor::types::*;
use hmi_io_point::manager::PointManager;
use hmi_io_point::types::WsConfigChangeMessage;
```

- [ ] **Step 24: Fix imports in `io-backend/crates/web/src/server.rs`**

Change:

```rust
use crate::db::repo::Repo;
use crate::monitor::collector::MonitorCollector;
use crate::plugin::registry::PluginRegistry;
use crate::point::manager::PointManager;
```

to:

```rust
use hmi_io_db::repo::Repo;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
```

- [ ] **Step 25: Add `io-backend/crates/web/Cargo.toml`**

```toml
[package]
name = "hmi-io-web"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-db.workspace = true
hmi-io-monitor.workspace = true
hmi-io-plugin.workspace = true
hmi-io-point.workspace = true
axum.workspace = true
tower-http.workspace = true
tokio.workspace = true
serde.workspace = true
serde_json.workspace = true
calamine.workspace = true
rust_xlsxwriter.workspace = true
anyhow.workspace = true
log.workspace = true
```

### 3.9 Create `hmi-io-backend` (binary)

**Files:**
- Move: `io-backend/src/main.rs` → `io-backend/crates/bin/src/main.rs`
- Add: `io-backend/crates/bin/Cargo.toml`

- [ ] **Step 26: Move `main.rs`**

```powershell
New-Item -ItemType Directory -Path io-backend/crates/bin/src -Force | Out-Null
git mv io-backend/src/main.rs io-backend/crates/bin/src/main.rs
```

- [ ] **Step 27: Rewrite the module declarations and imports in `io-backend/crates/bin/src/main.rs`**

Delete the module declarations at the top of the file:

```rust
mod bridge;
mod config;
mod db;
mod monitor;
mod plugin;
mod point;
mod server;
mod web;
```

Change the import block:

```rust
use bridge::bridge::Bridge;
use config::AppConfig;
use db::repo::Repo;
use monitor::collector::MonitorCollector;
use plugin::registry::PluginRegistry;
use point::manager::PointManager;
```

to:

```rust
use hmi_io_bridge::bridge::Bridge;
use hmi_io_config::AppConfig;
use hmi_io_db::repo::Repo;
use hmi_io_monitor::collector::MonitorCollector;
use hmi_io_plugin::registry::PluginRegistry;
use hmi_io_point::manager::PointManager;
```

Change the two fully-qualified call sites:

```rust
        crate::server::ws::run_server(&ws_cfg, bc_ws, reg_ws, pm_ws, mon_ws).await
```

to:

```rust
        hmi_io_server::ws::run_server(&ws_cfg, bc_ws, reg_ws, pm_ws, mon_ws).await
```

and:

```rust
            match crate::web::server::run_web_server(
```

to:

```rust
            match hmi_io_web::server::run_web_server(
```

Also change:

```rust
        let ws_cfg = config::ServerConfig {
```

to:

```rust
        let ws_cfg = hmi_io_config::ServerConfig {
```

- [ ] **Step 28: Add `io-backend/crates/bin/Cargo.toml`**

```toml
[package]
name = "hmi-io-backend"
version.workspace = true
edition.workspace = true

[dependencies]
hmi-io-bridge.workspace = true
hmi-io-config.workspace = true
hmi-io-db.workspace = true
hmi-io-monitor.workspace = true
hmi-io-plugin.workspace = true
hmi-io-point.workspace = true
hmi-io-server.workspace = true
hmi-io-web.workspace = true
tokio.workspace = true
anyhow.workspace = true
env_logger.workspace = true
log.workspace = true
serde_json.workspace = true
serde_yaml.workspace = true
```

### 3.10 Convert `io-backend/Cargo.toml` to the workspace root

- [ ] **Step 29: Replace the entire contents of `io-backend/Cargo.toml`**

Delete the old `[package]` section and use:

```toml
[workspace]
resolver = "2"
members = [
    "crates/bin",
    "crates/bridge",
    "crates/config",
    "crates/db",
    "crates/monitor",
    "crates/plugin",
    "crates/point",
    "crates/server",
    "crates/web",
    "crates/plugins/iec104",
    "crates/plugins/modbus-tcp",
    "crates/plugins/opc-ua",
    "crates/shared/iec104-core",
    "crates/shared/ua-core",
    "crates/test-servers/iec104-slave",
    "crates/test-servers/opcua-server",
]
default-members = [
    "crates/bin",
    "crates/bridge",
    "crates/config",
    "crates/db",
    "crates/monitor",
    "crates/plugin",
    "crates/point",
    "crates/server",
    "crates/web",
]

[workspace.package]
version = "0.3.0"
edition = "2021"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = "0.24"
futures-util = "0.3"
axum = { version = "0.8", features = ["ws", "multipart"] }
tower-http = { version = "0.6", features = ["fs", "cors"] }
rusqlite = { version = "0.34", features = ["bundled"] }
calamine = "0.26"
rust_xlsxwriter = "0.80"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
log = "0.4"
env_logger = "0.11"
anyhow = "1"
wasmtime = "47.0.2"
wasmtime-wasi = "47.0.2"
wit-bindgen = "0.58"
hmi-io-bridge = { path = "crates/bridge" }
hmi-io-config = { path = "crates/config" }
hmi-io-db = { path = "crates/db" }
hmi-io-monitor = { path = "crates/monitor" }
hmi-io-plugin = { path = "crates/plugin" }
hmi-io-point = { path = "crates/point" }
hmi-io-server = { path = "crates/server" }
hmi-io-web = { path = "crates/web" }
iec104-core = { path = "crates/shared/iec104-core" }
ua-core = { path = "crates/shared/ua-core" }

[profile.release]
opt-level = "s"
lto = true
strip = false

[profile.release.package.hmi-io-backend]
strip = true
```

Notes: `strip = false` at workspace level preserves the plugin behavior (wasm components are not stripped); the `hmi-io-backend` package override keeps the native binary stripped exactly as before.

- [ ] **Step 30: Update the moved plugin/shared Cargo.tomls to use workspace dependencies and drop per-crate profiles**

`io-backend/crates/plugins/modbus-tcp/Cargo.toml` — replace the whole file with:

```toml
[package]
name = "modbus-tcp-plugin"
version = "0.3.0"
edition.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen.workspace = true
serde.workspace = true
serde_json.workspace = true
```

`io-backend/crates/plugins/opc-ua/Cargo.toml` — replace the whole file with:

```toml
[package]
name = "opc-ua-plugin"
version = "0.3.0"
edition.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen.workspace = true
serde.workspace = true
serde_json.workspace = true
ua-core.workspace = true
```

`io-backend/crates/plugins/iec104/Cargo.toml` — replace the whole file with:

```toml
[package]
name = "iec104-plugin"
version = "0.3.0"
edition.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen.workspace = true
serde.workspace = true
serde_json.workspace = true
iec104-core.workspace = true
```

`io-backend/crates/shared/iec104-core/Cargo.toml` — replace the whole file with:

```toml
[package]
name = "iec104-core"
version = "0.1.0"
edition.workspace = true

[dependencies]
serde.workspace = true
```

`io-backend/crates/shared/ua-core/Cargo.toml` — replace the whole file with:

```toml
[package]
name = "ua-core"
version = "0.1.0"
edition.workspace = true

[dependencies]
serde.workspace = true
```

`io-backend/crates/test-servers/iec104-slave/Cargo.toml` and `io-backend/crates/test-servers/opcua-server/Cargo.toml` — replace `edition = "2021"` with `edition.workspace = true`; the `iec104-core.workspace = true` / `ua-core.workspace = true` lines are already correct.

- [ ] **Step 31: Delete the old standalone workspace manifest and the six old lockfiles**

Run:

```powershell
git rm io-backend/crates/test-servers/Cargo.toml
git rm io-backend/crates/plugins/iec104/Cargo.lock
git rm io-backend/crates/plugins/modbus-tcp/Cargo.lock
git rm io-backend/crates/plugins/opc-ua/Cargo.lock
git rm io-backend/crates/shared/iec104-core/Cargo.lock
git rm io-backend/crates/shared/ua-core/Cargo.lock
git rm io-backend/crates/test-servers/Cargo.lock
```

Expected: seven files removed from the index. The root `io-backend/Cargo.lock` stays and will be regenerated to cover all members.

- [ ] **Step 32: Remove the stale `.gitignore` entry**

In `.gitignore`, delete the line:

```gitignore
io-backend/plugins-src/*/target/
```

Keep everything else unchanged.

- [ ] **Step 33: Remove now-empty old directories**

Run:

```powershell
$dirs = @(
    "io-backend/plugins-src/shared",
    "io-backend/plugins-src",
    "io-backend/src"
)
foreach ($d in $dirs) {
    if ((Test-Path $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) {
        Remove-Item -LiteralPath $d -Force
    }
}
```

Expected: no output; the three empty directories are gone. (Each target path is explicitly listed and verified empty before removal.)

- [ ] **Step 34: Build the whole workspace**

Run:

```powershell
Set-Location io-backend
cargo build
```

Expected: workspace resolves, the 9 default members compile, `Finished` with no errors. The root `Cargo.lock` is updated to cover all members.

- [ ] **Step 35: Build plugins for wasm32-wasip2 from the workspace root**

Run:

```powershell
cargo build --target wasm32-wasip2 -p modbus-tcp-plugin -p opc-ua-plugin -p iec104-plugin
```

Expected: three plugin cdylibs compile to `target/wasm32-wasip2/debug/<name>_plugin.wasm`.

- [ ] **Step 36: Build the test servers**

Run:

```powershell
cargo build -p iec104-slave -p opcua-server
```

Expected: both binaries compile.

- [ ] **Step 37: Run host crate unit tests**

Run:

```powershell
cargo test
```

Expected: all default-member tests pass.

- [ ] **Step 38: Commit**

Run (repo root):

```powershell
git add -A
git commit -m "refactor: split backend into domain crates under a unified workspace"
```

---

## Task 4: Update build scripts

**Files:**
- Modify: `scripts/build.ps1`
- Verify: `scripts/dev.ps1` (no change expected)

- [ ] **Step 1: Rewrite the plugin build section of `scripts/build.ps1`**

Change:

```powershell
$PluginDir = Join-Path $BackendDir "plugins-src"
```

to:

```powershell
$PluginDir = Join-Path $BackendDir "crates\plugins"
```

Replace the plugin build loop:

```powershell
    $plugins = @("modbus-tcp", "opc-ua", "iec104")
    foreach ($plugin in $plugins) {
        $pluginPath = Join-Path $PluginDir $plugin
        Write-Host "  Building $plugin (target: $WasmTarget)..." -ForegroundColor Gray
        Push-Location $pluginPath
        try {
            cargo build @pluginArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Host "    ERROR: Build failed for $plugin" -ForegroundColor Red
                continue
            }
            $profile = if ($Release) { "release" } else { "debug" }
            $crateName = $plugin.Replace("-", "_")
            $wasmSrc = Join-Path $pluginPath ("target\{0}\{1}\{2}_plugin.wasm" -f $WasmTarget, $profile, $crateName)
            $wasmDst = Join-Path $OutputDir "${crateName}.wasm"
            if (Test-Path $wasmSrc) {
                Copy-Item $wasmSrc $wasmDst -Force
                $size = (Get-Item $wasmDst).Length
                Write-Host "    -> $wasmDst ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
            } else {
                Write-Host "    WARNING: $wasmSrc not found" -ForegroundColor Yellow
            }
        }
        finally {
            Pop-Location
        }
    }
```

with:

```powershell
    $plugins = @("modbus-tcp-plugin", "opc-ua-plugin", "iec104-plugin")
    foreach ($plugin in $plugins) {
        Write-Host "  Building $plugin (target: $WasmTarget)..." -ForegroundColor Gray
        Push-Location $BackendDir
        try {
            cargo build @pluginArgs @("-p", $plugin)
            if ($LASTEXITCODE -ne 0) {
                Write-Host "    ERROR: Build failed for $plugin" -ForegroundColor Red
                continue
            }
            $profile = if ($Release) { "release" } else { "debug" }
            $crateName = $plugin.Replace("-", "_")
            $meta = cargo metadata --format-version 1 | ConvertFrom-Json
            $targetDir = $meta.target_directory
            $wasmSrc = Join-Path $targetDir ("{0}\{1}\{2}_plugin.wasm" -f $WasmTarget, $profile, $crateName)
            $wasmDst = Join-Path $OutputDir "${crateName}.wasm"
            if (Test-Path $wasmSrc) {
                Copy-Item $wasmSrc $wasmDst -Force
                $size = (Get-Item $wasmDst).Length
                Write-Host "    -> $wasmDst ($([math]::Round($size/1KB, 1)) KB)" -ForegroundColor Green
            } else {
                Write-Host "    WARNING: $wasmSrc not found" -ForegroundColor Yellow
            }
        }
        finally {
            Pop-Location
        }
    }
```

The backend build step (`Push-Location $BackendDir; cargo build @backendArgs`) already builds the default members and needs no change.

- [ ] **Step 2: Run `.\scripts\build.ps1 -PluginsOnly`**

Run (repo root):

```powershell
.\scripts\build.ps1 -PluginsOnly
```

Expected: three plugins build and are copied to `io-backend/plugins/` as `modbus_tcp.wasm`, `opc_ua.wasm`, `iec104.wasm`.

- [ ] **Step 3: Verify `scripts/dev.ps1` needs no changes**

Run:

```powershell
Select-String -Path scripts\dev.ps1 -Pattern "plugins|io-backend|cargo run"
```

Expected: the only path references are `io-backend\plugins\modbus_tcp.wasm` (still correct) and `cargo run -- config.yaml` (still correct). No edit needed.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "build: build wasm plugins from unified workspace in build.ps1"
```

---

## Task 5: Update documentation

**Files:**
- Modify: `io-backend/README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the manual build commands in `io-backend/README.md`**

Replace the block:

```bash
# 构建 WASM 插件（wasip2 组件，产物名 = crate 名 + _plugin.wasm）
cd plugins-src/modbus-tcp && cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/modbus_tcp_plugin.wasm ../../plugins/modbus_tcp.wasm

cd ../opc-ua && cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/opc_ua_plugin.wasm ../../plugins/opc_ua.wasm

cd ../iec104 && cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/iec104_plugin.wasm ../../plugins/iec104.wasm

# 构建后端
cd ../.. && cargo build --release
```

with:

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

- [ ] **Step 2: Update the Guest/Host code-path references in `io-backend/README.md`**

Change:

```markdown
**Guest 侧写法**（`plugins-src/<plugin>/`）：
```

to:

```markdown
**Guest 侧写法**（`crates/plugins/<plugin>/`）：
```

Change the code sample line:

```rust
wit_bindgen::generate!({ world: "hmi-plugin", path: "../../wit" });
```

to:

```rust
wit_bindgen::generate!({ world: "hmi-plugin", path: "../../../wit" });
```

Change:

```markdown
**Host 侧**（`io-backend/src/plugin/`）：`bindgen!` + `wasmtime::component`，存储类型实现 `events::Host`（async import 返回 `Future<Output = ()>`），链接 `wasmtime_wasi::p2::add_to_linker_async`，经 `run_concurrent` 调用插件导出。
```

to:

```markdown
**Host 侧**（`crates/plugin/`）：`bindgen!` + `wasmtime::component`，存储类型实现 `events::Host`（async import 返回 `Future<Output = ()>`），链接 `wasmtime_wasi::p2::add_to_linker_async`，经 `run_concurrent` 调用插件导出。
```

- [ ] **Step 3: Update the directory structure tree in `io-backend/README.md`**

Replace the block from `├── Cargo.toml               # 后端依赖` through the end of the `plugins-src/` listing:

```markdown
├── Cargo.toml               # 后端依赖
├── src/                     # Rust 后端源码
│   ├── main.rs
│   ├── config.rs
│   ├── plugin/              # WASM 插件宿主（wasmtime component）
│   │   ├── host.rs          # wasmtime 引擎 + events 导入实现
│   │   ├── interface.rs     # bindgen! 契约生成
│   │   └── registry.rs      # 插件生命周期管理
│   ├── point/               # 点位管理
│   │   ├── types.rs
│   │   └── manager.rs
│   ├── monitor/             # 监控 API（:8081）
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

with:

```markdown
├── Cargo.toml               # Cargo workspace 根
├── crates/                  # 全部 Rust crate
│   ├── bin/                 # hmi-io-backend（可执行文件）
│   ├── config/              # hmi-io-config
│   ├── db/                  # hmi-io-db
│   ├── point/               # hmi-io-point
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

- [ ] **Step 4: Update `AGENTS.md` — project structure paragraph**

Change:

```markdown
- Backend in `io-backend/`: Rust modules in `src/` (bridge, db, monitor, plugin, point, server, web), compiled plugins in `plugins/`, sources in `plugins-src/<plugin>/`. Plugins are WASIp2 components built with `wit-bindgen` against the shared contract `io-backend/wit/hmi-plugin.wit` and run on wasmtime 47 (`wasmtime` + `wasmtime-wasi` crates); the host implements the `events` import (log / on-point / on-packet) in `src/plugin/host.rs`. Protocol codecs live in shared crates under `plugins-src/shared/` (`iec104-core`, `ua-core`) and are reused by the plugin guests and by local test servers under `io-backend/test-servers/` (a standalone Cargo workspace with `iec104-slave` on :2404 and `opcua-server` on :4840, used for end-to-end testing against `config.yaml`).
```

to:

```markdown
- Backend in `io-backend/`: one crate per domain under `io-backend/crates/` (`hmi-io-config`, `hmi-io-db`, `hmi-io-point`, `hmi-io-monitor`, `hmi-io-plugin`, `hmi-io-bridge`, `hmi-io-server`, `hmi-io-web`, plus the `hmi-io-backend` binary crate), compiled plugins in `plugins/`, sources in `crates/plugins/<plugin>/`. All crates belong to one Cargo workspace rooted at `io-backend/Cargo.toml`. Plugins are WASIp2 components built with `wit-bindgen` against the shared contract `io-backend/wit/hmi-plugin.wit` and run on wasmtime 47 (`wasmtime` + `wasmtime-wasi` crates); the host implements the `events` import (log / on-point / on-packet) in `crates/plugin/src/host.rs`. Protocol codecs live in shared crates under `crates/shared/` (`iec104-core`, `ua-core`) and are reused by the plugin guests and by local test servers under `crates/test-servers/` (`iec104-slave` on :2404 and `opcua-server` on :4840, used for end-to-end testing against `config.yaml`).
```

- [ ] **Step 5: Update `AGENTS.md` — command lines**

Change:

```markdown
- `cargo test` (in `plugins-src/<plugin>/`) — run plugin unit tests (e.g. encode/decode helpers in modbus-tcp)
- `cargo build`/`cargo test` (in `io-backend/test-servers/`) — build/run the local IEC 60870-5-104 slave (:2404) and OPC UA server (:4840) simulators; start each binary manually for E2E tests against the backend
```

to:

```markdown
- `cargo test` (in `io-backend/`) — run backend unit tests (default workspace members)
- `cargo test -p <plugin>` (e.g. `cargo test -p modbus-tcp-plugin`) — run plugin unit tests (e.g. encode/decode helpers in modbus-tcp)
- `cargo build -p iec104-slave -p opcua-server` (in `io-backend/`) — build the local IEC 60870-5-104 slave (:2404) and OPC UA server (:4840) simulators; start each binary manually for E2E tests against the backend
```

- [ ] **Step 6: Update `AGENTS.md` — wit paths and file references**

Change:

```markdown
- Guests (`plugins-src/<plugin>/`): `wit_bindgen::generate!({ world: "hmi-plugin", path: "../../wit" })`, implement `crate::exports::hmi::plugin::lifecycle::Guest` (methods have no `&self`), `export!(Plugin)`, and `await` the `hmi::plugin::events` imports directly inside the async exports.
- Host (`io-backend/src/plugin/`): `bindgen!({ world: "hmi-plugin", path: "wit" })`; store data must implement `wasmtime::component::HasData` plus `events::Host` and `events::HostWithStore` (async import methods take `&Accessor<T, D>` and return `impl Future<Output = ()>`); link with `wasmtime_wasi::p2::add_to_linker_async` and `HmiPlugin::add_to_linker::<S, S>`, instantiate with `HmiPlugin::instantiate_async`, call exports via `store.run_concurrent(...)`. Generated export instance type: `exports::hmi::plugin::lifecycle::Guest`.
```

to:

```markdown
- Guests (`crates/plugins/<plugin>/`): `wit_bindgen::generate!({ world: "hmi-plugin", path: "../../../wit" })`, implement `crate::exports::hmi::plugin::lifecycle::Guest` (methods have no `&self`), `export!(Plugin)`, and `await` the `hmi::plugin::events` imports directly inside the async exports.
- Host (`crates/plugin/`): `bindgen!({ world: "hmi-plugin", path: "../../wit" })`; store data must implement `wasmtime::component::HasData` plus `events::Host` and `events::HostWithStore` (async import methods take `&Accessor<T, D>` and return `impl Future<Output = ()>`); link with `wasmtime_wasi::p2::add_to_linker_async` and `HmiPlugin::add_to_linker::<S, S>`, instantiate with `HmiPlugin::instantiate_async`, call exports via `store.run_concurrent(...)`. Generated export instance type: `exports::hmi::plugin::lifecycle::Guest`.
```

Also in the same section, change:

```markdown
reusing shared codecs from `plugins-src/shared/` (`ua-core` all-little-endian, 1601-epoch DateTime, `iec104-core` ASDU/frame codecs).
```

to:

```markdown
reusing shared codecs from `crates/shared/` (`ua-core` all-little-endian, 1601-epoch DateTime, `iec104-core` ASDU/frame codecs).
```

And:

```markdown
- The host auto-reconnects a plugin whose `scan_points` returns a non-zero code (link loss): `io-backend/src/plugin/registry.rs` calls `connect()` again, rate-limited to one attempt per 5 s (`RECONNECT_MIN_INTERVAL`).
```

to:

```markdown
- The host auto-reconnects a plugin whose `scan_points` returns a non-zero code (link loss): `io-backend/crates/plugin/src/registry.rs` calls `connect()` again, rate-limited to one attempt per 5 s (`RECONNECT_MIN_INTERVAL`).
```

And:

```markdown
The same fields exist on the host as `PointMapping` (`io-backend/src/config.rs`) and in the plugin as `Pc`.
```

to:

```markdown
The same fields exist on the host as `PointMapping` (`io-backend/crates/config/src/lib.rs`) and in the plugin as `Pc`.
```

- [ ] **Step 7: Confirm `ARCHITECTURE.md` has no stale backend paths**

Run:

```powershell
rg -n "plugins-src|test-servers|io-backend/src" ARCHITECTURE.md
```

Expected: no matches. If matches appear, update them to the new paths.

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "docs: update backend paths and commands for crate workspace"
```

---

## Task 6: Full verification

**Files:** none (fixes only if a check fails)

- [ ] **Step 1: Host crates build and test**

Run:

```powershell
Set-Location io-backend
cargo build
cargo test
```

Expected: `Finished`, all tests pass.

- [ ] **Step 2: Entire workspace tests**

Run:

```powershell
cargo test --workspace
```

Expected: all members' tests pass (plugin and test-server crates compile).

- [ ] **Step 3: WASM plugin release build**

Run:

```powershell
cargo build --target wasm32-wasip2 -p modbus-tcp-plugin -p opc-ua-plugin -p iec104-plugin --release
```

Expected: three `.wasm` files under `target/wasm32-wasip2/release/`.

- [ ] **Step 4: Test servers build**

Run:

```powershell
cargo build -p iec104-slave -p opcua-server
```

Expected: both binaries compile.

- [ ] **Step 5: End-to-end build script**

Run (repo root):

```powershell
.\scripts\build.ps1 -Release
```

Expected: plugins built and copied to `io-backend/plugins/`, backend binary at `io-backend/target/release/hmi-io-backend.exe`, web UI built to `io-backend/web-ui/dist/`.

- [ ] **Step 6: Backend smoke run**

Run:

```powershell
Set-Location io-backend
cargo run -- config.yaml
```

Wait for these log lines, then stop with Ctrl+C:

```text
=== Ready ===
  Data WS:      ws://localhost:8080/iscs/data
  Web UI:       http://localhost:8081
```

Expected: the backend starts without path errors and shuts down cleanly on Ctrl+C.

- [ ] **Step 7: Stale-path sweep**

Run (repo root):

```powershell
rg -n "plugins-src|io-backend/src/|io-backend/test-servers" -g "!*.wasm" -g "!target/**" -g "!node_modules/**" -g "!dist/**" .
```

Expected: no matches (git history is not scanned). If any match appears outside historical references, fix it.

- [ ] **Step 8: Lockfile sanity**

Run:

```powershell
git ls-files | Select-String -Pattern "Cargo.lock"
```

Expected: only `io-backend/Cargo.lock` is tracked.

- [ ] **Step 9: Commit any verification fixes**

```powershell
git add -A
git commit -m "fix: resolve issues found during post-refactor verification"
```

Skip this step if nothing changed.

---

## Self-Review Notes

- Every spec requirement maps to a task: workspace root (Task 3.10), 16 members + default-members (Task 3.10), 9 host crates with the agreed boundaries and dependencies (Tasks 3.1–3.9), wit path updates (Tasks 2/3), script updates (Task 4), docs updates (Task 5), verification checklist (Task 6).
- No placeholders: every new file has complete contents; every import rewrite names the exact before/after lines.
- Type consistency: crate names used in `Cargo.toml` files match the `hmi_io_*` imports used in code (crate name `hmi-io-db` → import `hmi_io_db`, etc.); binary package stays `hmi-io-backend` so the executable name is unchanged.
