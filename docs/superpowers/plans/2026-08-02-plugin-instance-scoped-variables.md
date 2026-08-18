# Plugin-Instance-Scoped HMI Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HMI variables unique per plugin instance so the same variable name in different plugin instances binds to different HMI variables.

**Architecture:** Introduce a canonical composite point key `{plugin_name}:{variable_id}` in the `hmi-io-point` crate, then use it end-to-end: `PointManager` cache keys, plugin host `on_point` outgoing values, control write routing, the `/api/points` response (`hmi_id`), and the frontend `DataBridge` import. Plugin WASM guests, WIT, DB schema, and the management web-ui stay unchanged.

**Tech Stack:** Rust workspace crates (`hmi-io-point`, `hmi-io-plugin`, `hmi-io-config`, `hmi-io-db`, `hmi-io-web`, `hmi-io-backend`), TypeScript (`src/core/io/DataBridge.ts`), SQLite.

---

## Task 1: Add `point_key` helper

**Files:**

- Modify: `io-backend/crates/point/src/types.rs` (add function + test module at end)
- Modify: `io-backend/crates/point/src/lib.rs` (add re-export)

- [ ] **Step 1: Write the failing test**

Append to `io-backend/crates/point/src/types.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::point_key;

    #[test]
    fn point_key_combines_plugin_instance_and_variable() {
        assert_eq!(
            point_key("modbus_1", "STA1_TEMP_ZONE1"),
            "modbus_1:STA1_TEMP_ZONE1"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `io-backend/`): `cargo test -p hmi-io-point point_key_combines_plugin_instance_and_variable`

Expected: FAIL — `cannot find function 'point_key' in module 'types'`.

- [ ] **Step 3: Implement `point_key`**

In `io-backend/crates/point/src/types.rs`, after the `PointValue` impl block, add:

```rust
/// Build the HMI-facing unique point key for a plugin instance point.
///
/// Format: `{plugin_name}:{variable_id}`. Plugin names are unique in the
/// database, so the same variable name in different instances stays distinct.
pub fn point_key(plugin_name: &str, variable_id: &str) -> String {
    format!("{}:{}", plugin_name, variable_id)
}
```

In `io-backend/crates/point/src/lib.rs`, replace:

```rust
pub mod manager;
pub mod types;
```

with:

```rust
pub mod manager;
pub mod types;

pub use types::point_key;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p hmi-io-point point_key_combines_plugin_instance_and_variable`

Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/point/src/types.rs io-backend/crates/point/src/lib.rs
git commit -m "feat: add point_key helper for plugin-scoped HMI variables"
```

---

## Task 2: Key `PointManager` by composite point key

**Files:**

- Modify: `io-backend/crates/point/src/manager.rs`

- [ ] **Step 1: Write the failing tests**

Inside the existing `#[cfg(test)] mod tests` block in `io-backend/crates/point/src/manager.rs`, add the imports line at the top of the test module:

```rust
    use hmi_io_config::PluginInstance as PluginInstanceConfig;
    use crate::types::point_key;
```

Then append these tests:

```rust
    #[test]
    fn same_variable_id_across_instances_are_distinct() {
        let mut config = AppConfig::default_config();
        config.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
            },
        ];
        let mgr = PointManager::from_config(&config);
        assert_eq!(mgr.count(), 2);
        assert!(mgr.has_point(&point_key("mb1", "P1")));
        assert!(mgr.has_point(&point_key("mb2", "P1")));
    }

    #[test]
    fn same_variable_id_across_instances_update_independently() {
        let mut config = AppConfig::default_config();
        config.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![make_mapping("P1")],
            },
        ];
        let mut mgr = PointManager::from_config(&config);
        mgr.update(PointValue::new(&point_key("mb1", "P1"), 1.0, "good", 1000));
        mgr.update(PointValue::new(&point_key("mb2", "P1"), 2.0, "good", 1001));
        let vals = mgr.get_all_values();
        assert_eq!(vals.len(), 2);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p hmi-io-point manager::tests`

Expected: FAIL — `assert_eq!(mgr.count(), 2)` gets 1 (both `P1` entries collapse into one key).

- [ ] **Step 3: Implement composite keys in `from_config`**

In `io-backend/crates/point/src/manager.rs`, change the import to:

```rust
use crate::types::{point_key, PointValue};
```

Replace the `from_config` body:

```rust
    pub fn from_config(config: &AppConfig) -> Self {
        let mut points = HashMap::new();
        for inst in &config.plugins.instances {
            for pt in &inst.points {
                points.insert(
                    point_key(&inst.name, &pt.id),
                    CachedPoint {
                        mapping: pt.clone(),
                        last_value: None,
                    },
                );
            }
        }
        log::info!("PointManager: {} points configured", points.len());
        Self { points }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p hmi-io-point`

Expected: PASS — all existing tests plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/point/src/manager.rs
git commit -m "fix: key PointManager by plugin instance and variable name"
```

---

## Task 3: Tag plugin point values with the composite id

**Files:**

- Modify: `io-backend/crates/plugin/src/host.rs`

- [ ] **Step 1: Write the failing test**

Append to `io-backend/crates/plugin/src/host.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::outgoing_point;

    #[test]
    fn outgoing_point_uses_composite_key() {
        let pv = outgoing_point("mb1", "P1", 42.0, "good", 1000);
        assert_eq!(pv.id, "mb1:P1");
        assert_eq!(pv.value, serde_json::json!(42.0));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p hmi-io-plugin outgoing_point_uses_composite_key`

Expected: FAIL — `cannot find function 'outgoing_point' in this scope`.

- [ ] **Step 3: Implement the helper and use it in `on_point`**

In `io-backend/crates/plugin/src/host.rs`:

1. Change the import from:

```rust
use hmi_io_point::types::PointValue;
```

to:

```rust
use hmi_io_point::{point_key, types::PointValue};
```

2. Add this module-level helper before `impl events::HostWithStore<HostState> for HostState`:

```rust
fn outgoing_point(
    plugin_name: &str,
    variable_id: &str,
    value: f64,
    quality: &str,
    timestamp: u64,
) -> PointValue {
    PointValue::new(
        &point_key(plugin_name, variable_id),
        value,
        quality,
        timestamp,
    )
}
```

3. Replace the `on_point` async block:

```rust
        async move {
            accessor.with(|mut access| {
                let s: &mut HostState = access.get();
                let qs = if quality.is_empty() { "good" } else { &quality };
                let raw = PointValue::new(&name, value, qs, timestamp);
                s.monitor.update_point_value(&s.plugin_name, &raw);
                let _ = s
                    .point_tx
                    .send(outgoing_point(&s.plugin_name, &name, value, qs, timestamp));
            });
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p hmi-io-plugin`

Expected: PASS — new helper test passes and existing code compiles.

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/plugin/src/host.rs
git commit -m "fix: tag plugin point values with composite hmi id"
```

---

## Task 4: Route control writes to the exact plugin instance

**Files:**

- Modify: `io-backend/crates/plugin/src/registry.rs`

- [ ] **Step 1: Write the failing tests**

Append to `io-backend/crates/plugin/src/registry.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_config::PointMapping;

    fn mapping(id: &str) -> PointMapping {
        PointMapping {
            id: id.into(),
            address: "coil:0".into(),
            data_type: "bool".into(),
            byte_order: "big_endian".into(),
            scale: 1.0,
            offset: 0.0,
            var_type: "DI".into(),
        }
    }

    fn config_with_two_instances() -> AppConfig {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            PluginInstanceConfig {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
            },
            PluginInstanceConfig {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1"), mapping("P2")],
            },
        ];
        cfg
    }

    #[test]
    fn resolve_write_target_routes_to_correct_instance() {
        let cfg = config_with_two_instances();
        assert_eq!(
            resolve_write_target(&cfg, "mb1:P1"),
            Some(("mb1".to_string(), "P1".to_string()))
        );
        assert_eq!(
            resolve_write_target(&cfg, "mb2:P1"),
            Some(("mb2".to_string(), "P1".to_string()))
        );
        assert_eq!(
            resolve_write_target(&cfg, "mb2:P2"),
            Some(("mb2".to_string(), "P2".to_string()))
        );
    }

    #[test]
    fn resolve_write_target_unknown_returns_none() {
        let cfg = config_with_two_instances();
        assert_eq!(resolve_write_target(&cfg, "mb1:P2"), None);
        assert_eq!(resolve_write_target(&cfg, "P1"), None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p hmi-io-plugin resolve_write_target`

Expected: FAIL — `cannot find function 'resolve_write_target' in this scope`.

- [ ] **Step 3: Implement routing and rewire `write_point`**

In `io-backend/crates/plugin/src/registry.rs`:

1. Change the import from:

```rust
use hmi_io_point::types::PointValue;
```

to:

```rust
use hmi_io_point::{point_key, types::PointValue};
```

2. Replace the whole `write_point` method:

```rust
    pub async fn write_point(&self, point_name: &str, value: f64) -> anyhow::Result<()> {
        let target = {
            let cache = self.config_cache.lock().unwrap();
            cache
                .as_ref()
                .and_then(|cfg| resolve_write_target(cfg, point_name))
        };
        let Some((plugin_name, variable_id)) = target else {
            anyhow::bail!("point '{}' not found in any plugin instance", point_name);
        };

        let cmd_tx = {
            let plugins = self.plugins.lock().unwrap();
            plugins.get(&plugin_name).map(|h| h.cmd_tx.clone())
        };
        let Some(cmd_tx) = cmd_tx else {
            anyhow::bail!("plugin instance '{}' is not running", plugin_name);
        };

        let (tx, rx) = oneshot::channel();
        cmd_tx
            .send(PluginCommand::WritePoint {
                name: variable_id,
                value,
                reply: tx,
            })
            .map_err(|_| anyhow::anyhow!("plugin '{}' is not accepting commands", plugin_name))?;

        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => anyhow::bail!("plugin '{}' rejected write: {}", plugin_name, e),
            Err(e) => anyhow::bail!("plugin '{}' write failed: {}", plugin_name, e),
        }
    }
```

3. Add this function after `write_point`:

```rust
fn resolve_write_target(config: &AppConfig, point_name: &str) -> Option<(String, String)> {
    config.plugins.instances.iter().find_map(|inst| {
        inst.points
            .iter()
            .find(|pt| point_key(&inst.name, &pt.id) == point_name)
            .map(|pt| (inst.name.clone(), pt.id.clone()))
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p hmi-io-plugin`

Expected: PASS — all registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/plugin/src/registry.rs
git commit -m "fix: route control writes to exact plugin instance"
```

---

## Task 5: Reject duplicate plugin instance names at startup

**Files:**

- Modify: `io-backend/crates/config/src/lib.rs`
- Modify: `io-backend/crates/bin/src/main.rs`

- [ ] **Step 1: Write the failing tests**

Append to `io-backend/crates/config/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn instance(name: &str) -> PluginInstance {
        PluginInstance {
            name: name.into(),
            wasm_file: "p.wasm".into(),
            config: serde_json::json!({}),
            points: vec![],
        }
    }

    #[test]
    fn validate_accepts_unique_instance_names() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![instance("modbus_1"), instance("modbus_2")];
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_rejects_duplicate_instance_names() {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![instance("modbus_tcp"), instance("modbus_tcp")];
        let err = cfg.validate().unwrap_err();
        assert!(err.to_string().contains("modbus_tcp"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p hmi-io-config validate`

Expected: FAIL — `no method named 'validate' found for struct 'AppConfig'`.

- [ ] **Step 3: Implement `validate` and wire it into startup**

In `io-backend/crates/config/src/lib.rs`, add this method inside `impl AppConfig`:

```rust
    pub fn validate(&self) -> anyhow::Result<()> {
        let mut seen = std::collections::HashSet::new();
        for inst in &self.plugins.instances {
            if !seen.insert(inst.name.clone()) {
                anyhow::bail!(
                    "duplicate plugin instance name '{}'; instance names must be unique",
                    inst.name
                );
            }
        }
        Ok(())
    }
```

In `io-backend/crates/bin/src/main.rs`, change the signature and calls:

1. Replace:

```rust
    let app_config = build_config(&repo, &config_path);
```

with:

```rust
    let app_config = build_config(&repo, &config_path)?;
```

2. Replace the function:

```rust
fn build_config(repo: &Repo, yaml_path: &str) -> AppConfig {
    if let Ok(plugins) = repo.list_plugins() {
        if !plugins.is_empty() {
            log::info!("Loading config from database");
            return AppConfig::from_repo_sync(repo);
        }
    }
    log::info!("Loading config from {}", yaml_path);
    let app_config = match AppConfig::load(yaml_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!("YAML load failed ({}), using defaults", e);
            let d = AppConfig::default_config();
            let _ = std::fs::write(yaml_path, serde_yaml::to_string(&d).unwrap_or_default());
            d
        }
    };
    migrate_yaml_to_db(repo, &app_config);
    app_config
}
```

with:

```rust
fn build_config(repo: &Repo, yaml_path: &str) -> anyhow::Result<AppConfig> {
    if let Ok(plugins) = repo.list_plugins() {
        if !plugins.is_empty() {
            log::info!("Loading config from database");
            let cfg = AppConfig::from_repo_sync(repo);
            cfg.validate()?;
            return Ok(cfg);
        }
    }
    log::info!("Loading config from {}", yaml_path);
    let app_config = match AppConfig::load(yaml_path) {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!("YAML load failed ({}), using defaults", e);
            let d = AppConfig::default_config();
            let _ = std::fs::write(yaml_path, serde_yaml::to_string(&d).unwrap_or_default());
            d
        }
    };
    app_config.validate()?;
    migrate_yaml_to_db(repo, &app_config);
    Ok(app_config)
}
```

- [ ] **Step 4: Run tests and build to verify**

Run: `cargo test -p hmi-io-config validate`

Expected: PASS (2 tests).

Run: `cargo build -p hmi-io-backend`

Expected: BUILD SUCCESSFUL (main.rs compiles with the new `?`).

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/config/src/lib.rs io-backend/crates/bin/src/main.rs
git commit -m "fix: reject duplicate plugin instance names on startup"
```

---

## Task 6: Include plugin name in point rows

**Files:**

- Modify: `io-backend/crates/db/src/repo.rs`

- [ ] **Step 1: Write the failing test**

Append to `io-backend/crates/db/src/repo.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_points_includes_plugin_name() {
        let repo = Repo::new(":memory:").unwrap();
        let pid = repo
            .insert_plugin("modbus_tcp", "modbus_tcp.wasm", "{}")
            .unwrap();
        repo.insert_point(pid, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();
        let points = repo.list_points(None).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].plugin_name, "modbus_tcp");
        assert_eq!(points[0].variable_id, "P1");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p hmi-io-db list_points_includes_plugin_name`

Expected: FAIL — compile error `no field 'plugin_name' on type 'PointRow'`.

- [ ] **Step 3: Add the field, join SQL, and mapper**

In `io-backend/crates/db/src/repo.rs`:

1. Add `pub plugin_name: String,` to `PointRow` after `plugin_id`:

```rust
pub struct PointRow {
    pub id: i64,
    pub plugin_id: i64,
    pub plugin_name: String,
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}
```

2. Update `map_point`:

```rust
fn map_point(row: &rusqlite::Row) -> rusqlite::Result<PointRow> {
    Ok(PointRow {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        plugin_name: row.get(10)?,
        variable_id: row.get(2)?,
        address: row.get(3)?,
        data_type: row.get(4)?,
        byte_order: row.get(5)?,
        scale: row.get(6)?,
        offset_val: row.get(7)?,
        var_type: row.get(8)?,
        description: row.get::<_, String>(9).unwrap_or_default(),
    })
}
```

3. Replace the SQL in `list_points`:

```rust
        let mut sql = conn.prepare(
            "SELECT p.id, p.plugin_id, p.variable_id, p.address, p.data_type, p.byte_order, p.scale, p.offset_val, p.var_type, p.description, pl.name
             FROM points p JOIN plugins pl ON pl.id = p.plugin_id
             WHERE (?1 IS NULL OR p.plugin_id = ?1)
             ORDER BY p.plugin_id, p.id",
        )?;
```

4. Replace the SQL in `get_point`:

```rust
        let mut sql = conn.prepare(
            "SELECT p.id, p.plugin_id, p.variable_id, p.address, p.data_type, p.byte_order, p.scale, p.offset_val, p.var_type, p.description, pl.name
             FROM points p JOIN plugins pl ON pl.id = p.plugin_id
             WHERE p.id=?1",
        )?;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p hmi-io-db`

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/db/src/repo.rs
git commit -m "feat: include plugin name in point rows"
```

---

## Task 7: Expose `hmi_id` and filter by composite key in the points API

**Files:**

- Modify: `io-backend/crates/web/Cargo.toml` (dev-dependency)
- Modify: `io-backend/crates/web/src/api.rs`

- [ ] **Step 1: Add dev-dependency and write failing tests**

Append to `io-backend/crates/web/Cargo.toml`:

```toml
[dev-dependencies]
hmi-io-config.workspace = true
```

Append to `io-backend/crates/web/src/api.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use hmi_io_config::{AppConfig, PluginInstance, PointMapping};

    fn mapping(id: &str) -> PointMapping {
        PointMapping {
            id: id.into(),
            address: "coil:0".into(),
            data_type: "bool".into(),
            byte_order: "big_endian".into(),
            scale: 1.0,
            offset: 0.0,
            var_type: "DI".into(),
        }
    }

    fn point_manager_with_two_instances() -> Arc<Mutex<PointManager>> {
        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![
            PluginInstance {
                name: "mb1".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
            },
            PluginInstance {
                name: "mb2".into(),
                wasm_file: "modbus.wasm".into(),
                config: serde_json::json!({}),
                points: vec![mapping("P1")],
            },
        ];
        Arc::new(Mutex::new(PointManager::from_config(&cfg)))
    }

    #[tokio::test]
    async fn list_points_returns_composite_hmi_id() {
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let pid = repo
            .insert_plugin("modbus_tcp", "modbus_tcp.wasm", "{}")
            .unwrap();
        repo.insert_point(pid, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();

        let mut cfg = AppConfig::default_config();
        cfg.plugins.instances = vec![PluginInstance {
            name: "modbus_tcp".into(),
            wasm_file: "modbus_tcp.wasm".into(),
            config: serde_json::json!({}),
            points: vec![mapping("P1")],
        }];
        let pm = Arc::new(Mutex::new(PointManager::from_config(&cfg)));

        let res = list_points(
            State(repo),
            Extension(pm),
            Query(PluginQuery { plugin_id: None }),
        )
        .await
        .unwrap();
        let points = res.0;
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].plugin_name, "modbus_tcp");
        assert_eq!(points[0].hmi_id, "modbus_tcp:P1");
    }

    #[tokio::test]
    async fn list_points_keeps_same_name_across_instances() {
        let repo = Arc::new(Repo::new(":memory:").unwrap());
        let p1 = repo.insert_plugin("mb1", "modbus.wasm", "{}").unwrap();
        let p2 = repo.insert_plugin("mb2", "modbus.wasm", "{}").unwrap();
        repo.insert_point(p1, "P1", "coil:0", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();
        repo.insert_point(p2, "P1", "coil:1", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();

        let res = list_points(
            State(repo),
            Extension(point_manager_with_two_instances()),
            Query(PluginQuery { plugin_id: None }),
        )
        .await
        .unwrap();
        let points = res.0;
        assert_eq!(points.len(), 2);
        let ids: Vec<&str> = points.iter().map(|p| p.hmi_id.as_str()).collect();
        assert!(ids.contains(&"mb1:P1"));
        assert!(ids.contains(&"mb2:P1"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p hmi-io-web list_points`

Expected: FAIL — compile error `cannot find struct, variant or union type 'PointView'`.

- [ ] **Step 3: Add `PointView` and update `list_points`**

In `io-backend/crates/web/src/api.rs`:

1. Add to the imports:

```rust
use hmi_io_point::point_key;
```

2. Add before `list_points`:

```rust
#[derive(Serialize)]
pub struct PointView {
    pub id: i64,
    pub plugin_id: i64,
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
    pub plugin_name: String,
    pub hmi_id: String,
}

impl From<PointRow> for PointView {
    fn from(row: PointRow) -> Self {
        let hmi_id = point_key(&row.plugin_name, &row.variable_id);
        Self {
            id: row.id,
            plugin_id: row.plugin_id,
            variable_id: row.variable_id,
            address: row.address,
            data_type: row.data_type,
            byte_order: row.byte_order,
            scale: row.scale,
            offset_val: row.offset_val,
            var_type: row.var_type,
            description: row.description,
            plugin_name: row.plugin_name,
            hmi_id,
        }
    }
}
```

3. Replace `list_points`:

```rust
pub async fn list_points(
    State(repo): State<AppState>,
    Extension(point_manager): Extension<Arc<Mutex<PointManager>>>,
    Query(q): Query<PluginQuery>,
) -> Result<Json<Vec<PointView>>, StatusCode> {
    let all_points = repo.list_points(q.plugin_id).map_err(|e| {
        log::error!("{}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let total_in_db = all_points.len();
    // 以 PointManager 为准：只返回实际在管理范围内的点（按组合 ID 匹配）
    let pm = point_manager.lock().unwrap();
    let filtered: Vec<PointView> = all_points
        .into_iter()
        .filter(|p| pm.has_point(&point_key(&p.plugin_name, &p.variable_id)))
        .map(PointView::from)
        .collect();
    if filtered.len() != total_in_db {
        log::warn!(
            "list_points: DB has {} points, PointManager manages {} ({} dropped)",
            total_in_db,
            pm.count(),
            total_in_db - filtered.len()
        );
    }
    Ok(Json(filtered))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p hmi-io-web`

Expected: PASS — both new API tests pass.

- [ ] **Step 5: Commit**

```bash
git add io-backend/crates/web/Cargo.toml io-backend/crates/web/src/api.rs io-backend/Cargo.lock
git commit -m "feat: expose hmi_id in points api"
```

---

## Task 8: Import per-instance variables in the HMI without dedup

**Files:**

- Modify: `src/core/io/DataBridge.ts`

Note: the repo has no frontend test runner (see AGENTS.md); verification for this task is `npm run build` plus the manual E2E in Task 9.

- [ ] **Step 1: Replace the backend import logic**

In `src/core/io/DataBridge.ts`, replace the whole `fetchVariablesFromBackend` method:

```ts
  async fetchVariablesFromBackend(apiBaseUrl?: string): Promise<number> {
    const base = apiBaseUrl ?? this.apiBaseUrl;
    this.apiBaseUrl = base;
    const url = `${base}/api/points`;
    console.log("[DataBridge] 正在从后端拉取变量列表?", url);
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const points: Array<{
        id: number;
        plugin_id: number;
        variable_id: string;
        address: string;
        data_type: string;
        byte_order: string;
        scale: number;
        offset_val: number;
        var_type: string;
        description?: string;
        plugin_name?: string;
        hmi_id?: string;
      }> = await resp.json();

      console.log(`[DataBridge] 后端返回 ${points.length} 个点`);

      // 清空旧映射
      this.pointIdToVarId.clear();
      this.varIdToPointId.clear();

      // HMI 变量 ID 使用后端计算的 hmi_id（插件实例名:变量名）。
      // 不同插件实例中的同名变量是不同变量，不再按 variable_id 去重合并。
      const defs: Array<{
        id: string;
        name: string;
        type: VariableType;
        address: string;
        defaultValue: number;
        unit: string;
        description: string;
        group: string;
        min: number;
        max: number;
        alarmHigh: number;
        alarmLow: number;
      }> = [];

      for (const p of points) {
        const varType: VariableType = ["AI", "DI", "AO", "DO"].includes(
          p.var_type,
        )
          ? (p.var_type as VariableType)
          : "AI";
        const backendPointId = String(p.id);
        const hmiId =
          p.hmi_id ??
          (p.plugin_name ? `${p.plugin_name}:${p.variable_id}` : p.variable_id);
        const groupName = p.plugin_name ?? `plugin ${p.plugin_id}`;

        // 双向映射：后端 DB id / hmi_id 都指向同一个 HMI 变量；
        // 控制命令以 hmi_id 为准，由后端路由到对应插件实例。
        this.pointIdToVarId.set(backendPointId, hmiId);
        this.pointIdToVarId.set(hmiId, hmiId);
        this.varIdToPointId.set(hmiId, hmiId);

        defs.push({
          id: hmiId,
          name: p.variable_id,
          type: varType,
          address: p.address,
          defaultValue: 0,
          unit: "",
          description: p.description ?? p.data_type + " / " + p.byte_order,
          group: `IO Backend (${groupName})`,
          min: 0,
          max: varType === "AI" || varType === "AO" ? 100 : 1,
          alarmHigh: 0,
          alarmLow: 0,
        });
      }

      this.variableManager.replaceAll(defs);

      // 重放最近一次收到的值：WS 快照通常先于 /api/points 导入完成到达，
      // 若直接 setValue 会因变量尚未定义而被丢弃。导入完成后补写一次。
      for (const [id, p] of this.lastValues) {
        this.variableManager.setValue(id, p.value, p.quality);
      }

      console.log(
        `[DataBridge] 变量列表已导入 ${defs.length} 个（后端返回 ${points.length} 条）, 映射表 ${this.pointIdToVarId.size} 条`,
      );
      this.onVarsRefreshed?.();
      return defs.length;
    } catch (err) {
      console.error("[DataBridge] 拉取变量列表失败:", err);
      throw err;
    }
  }
```

- [ ] **Step 2: Verify the frontend builds**

Run (repo root): `npm run build`

Expected: `tsc -b` and `vite build` succeed with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/io/DataBridge.ts
git commit -m "fix: import per-instance variables in HMI without dedup"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all backend tests**

Run (in `io-backend/`): `cargo test`

Expected: all workspace default-member tests pass.

- [ ] **Step 2: Run the frontend build**

Run (repo root): `npm run build`

Expected: build succeeds.

- [ ] **Step 3: Manual E2E — backend API returns distinct composite ids**

1. Ensure plugin WASM files exist (in `io-backend/plugins/`); if not, run `.\scripts\build.ps1 -PluginsOnly` from the repo root.
2. Start the backend (in `io-backend/`): `cargo run -- config.yaml`
3. In another terminal:

```powershell
Invoke-RestMethod http://localhost:8081/api/points | ConvertTo-Json -Depth 5
```

Expected: rows with the same `variable_id` (e.g. `STA1_TEMP_ZONE1`) appear once per plugin instance, each with a distinct `hmi_id` (`modbus_tcp:STA1_TEMP_ZONE1`, `opc_ua:STA1_TEMP_ZONE1`) and matching `plugin_name`.

- [ ] **Step 4: Manual E2E — HMI imports both instances**

1. Start the frontend (repo root): `npm run dev`
2. Open the HMI editor, go to 数据连接, select IO 后端, set REST API to `http://localhost:8081`, connect, and let the variable list import.
3. Expected: the variable list contains e.g. both `modbus_tcp:STA1_TEMP_ZONE1` and `opc_ua:STA1_TEMP_ZONE1` as separate entries, and their values update independently as each protocol reports data.
4. Expected: a control command on either entry is routed to the correct plugin instance (observe the target protocol's point value changes while the other instance's value stays).

- [ ] **Step 5: Manual E2E — duplicate instance names fail loudly (optional)**

Create a temporary `dup.yaml` in `io-backend/` with two instances both named `modbus_tcp`, then run:

```powershell
cargo run -- dup.yaml
```

Expected: startup fails with `duplicate plugin instance name 'modbus_tcp'; instance names must be unique`.

Delete `dup.yaml` afterwards.
