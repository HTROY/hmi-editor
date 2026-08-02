//! Repository layer - thread-safe CRUD for plugins and points

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRow {
    pub id: i64,
    pub name: String,
    pub wasm_file: String,
    pub config_json: String,
    pub enabled: bool,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub priority: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointRow {
    pub id: i64,
    pub plugin_id: i64,
    pub plugin_name: String,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginWithPoints {
    pub plugin: PluginRow,
    pub points: Vec<PointRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub config_version: u64,
    pub scan_interval_ms: u64,
    pub batch_interval_ms: u64,
    pub plugin_dir: String,
    pub redundancy: serde_json::Value,
    pub plugins: Vec<SnapshotPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPlugin {
    pub name: String,
    pub wasm_file: String,
    pub config_json: String,
    pub enabled: bool,
    pub redundancy_group: String,
    pub redundancy_role: String,
    pub priority: u32,
    pub points: Vec<SnapshotPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPoint {
    pub variable_id: String,
    pub address: String,
    pub data_type: String,
    pub byte_order: String,
    pub scale: f64,
    pub offset_val: f64,
    pub var_type: String,
    pub description: String,
}

pub struct Repo {
    conn: Mutex<Connection>,
}

fn map_plugin(row: &rusqlite::Row) -> rusqlite::Result<PluginRow> {
    Ok(PluginRow {
        id: row.get(0)?,
        name: row.get(1)?,
        wasm_file: row.get(2)?,
        config_json: row.get(3)?,
        enabled: row.get::<_, i32>(4)? != 0,
        redundancy_group: row.get(5)?,
        redundancy_role: row.get(6)?,
        priority: row.get(7)?,
    })
}
fn map_point(row: &rusqlite::Row) -> rusqlite::Result<PointRow> {
    Ok(PointRow {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        plugin_name: row.get(10)?,
        redundancy_group: row.get(11)?,
        redundancy_role: row.get(12)?,
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

impl Repo {
    pub fn new(path: &str) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        super::schema::init_db(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get_config(&self, key: &str) -> Option<String> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM server_config WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .ok()
    }
    pub fn set_config(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO server_config(key,value) VALUES(?1,?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn list_plugins(&self) -> anyhow::Result<Vec<PluginRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql =
            conn.prepare("SELECT id,name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority FROM plugins ORDER BY id")?;
        let rows: Vec<PluginRow> = sql
            .query_map([], |r| map_plugin(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn get_plugin(&self, id: i64) -> anyhow::Result<Option<PluginRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql =
            conn.prepare("SELECT id,name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority FROM plugins WHERE id=?1")?;
        let mut rows = sql.query_map(params![id], |r| map_plugin(r))?;
        match rows.next() {
            Some(Ok(r)) => Ok(Some(r)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }
    pub fn insert_plugin(
        &self,
        name: &str,
        wasm_file: &str,
        config_json: &str,
    ) -> anyhow::Result<i64> {
        self.insert_plugin_full(name, wasm_file, config_json, "", "", 0)
    }

    pub fn insert_plugin_full(
        &self,
        name: &str,
        wasm_file: &str,
        config_json: &str,
        redundancy_group: &str,
        redundancy_role: &str,
        priority: u32,
    ) -> anyhow::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plugins(name,wasm_file,config_json,redundancy_group,redundancy_role,priority)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![name, wasm_file, config_json, redundancy_group, redundancy_role, priority],
        )?;
        Ok(conn.last_insert_rowid())
    }
    pub fn update_plugin(
        &self,
        id: i64,
        name: &str,
        wasm_file: &str,
        config_json: &str,
        enabled: bool,
    ) -> anyhow::Result<()> {
        self.update_plugin_full(id, name, wasm_file, config_json, "", "", 0, enabled)
    }

    pub fn update_plugin_full(
        &self,
        id: i64,
        name: &str,
        wasm_file: &str,
        config_json: &str,
        redundancy_group: &str,
        redundancy_role: &str,
        priority: u32,
        enabled: bool,
    ) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE plugins SET name=?2,wasm_file=?3,config_json=?4,redundancy_group=?5,redundancy_role=?6,priority=?7,enabled=?8,updated_at=datetime('now') WHERE id=?1",
            params![id, name, wasm_file, config_json, redundancy_group, redundancy_role, priority, enabled as i32],
        )?;
        Ok(())
    }
    pub fn delete_plugin(&self, id: i64) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM plugins WHERE id=?1", params![id])?;
        Ok(())
    }
    pub fn list_points(&self, plugin_id: Option<i64>) -> anyhow::Result<Vec<PointRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT p.id, p.plugin_id, p.variable_id, p.address, p.data_type, p.byte_order, p.scale, p.offset_val, p.var_type, p.description, pl.name, pl.redundancy_group, pl.redundancy_role
             FROM points p JOIN plugins pl ON pl.id = p.plugin_id
             WHERE (?1 IS NULL OR p.plugin_id = ?1)
             ORDER BY p.plugin_id, p.id",
        )?;
        let rows: Vec<PointRow> = sql
            .query_map(params![plugin_id], |r| map_point(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn get_point(&self, id: i64) -> anyhow::Result<Option<PointRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT p.id, p.plugin_id, p.variable_id, p.address, p.data_type, p.byte_order, p.scale, p.offset_val, p.var_type, p.description, pl.name, pl.redundancy_group, pl.redundancy_role
             FROM points p JOIN plugins pl ON pl.id = p.plugin_id
             WHERE p.id=?1",
        )?;
        let mut rows = sql.query_map(params![id], |r| map_point(r))?;
        match rows.next() {
            Some(Ok(r)) => Ok(Some(r)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }
    pub fn insert_point(
        &self,
        plugin_id: i64,
        var_id: &str,
        addr: &str,
        dtype: &str,
        border: &str,
        scale: f64,
        offset_val: f64,
        vtype: &str,
        description: &str,
    ) -> anyhow::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT OR REPLACE INTO points(plugin_id,variable_id,address,data_type,byte_order,scale,offset_val,var_type,description) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![plugin_id, var_id, addr, dtype, border, scale, offset_val, vtype, description])?;
        Ok(conn.last_insert_rowid())
    }
    pub fn update_point(
        &self,
        id: i64,
        var_id: &str,
        addr: &str,
        dtype: &str,
        border: &str,
        scale: f64,
        offset_val: f64,
        vtype: &str,
        description: &str,
    ) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute("UPDATE points SET variable_id=?2,address=?3,data_type=?4,byte_order=?5,scale=?6,offset_val=?7,var_type=?8,description=?9 WHERE id=?1", params![id, var_id, addr, dtype, border, scale, offset_val, vtype, description])?;
        Ok(())
    }
    pub fn delete_point(&self, id: i64) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM points WHERE id=?1", params![id])?;
        Ok(())
    }
    pub fn list_plugins_with_points(&self) -> anyhow::Result<Vec<PluginWithPoints>> {
        let plugins = self.list_plugins()?;
        plugins
            .into_iter()
            .map(|p| {
                Ok(PluginWithPoints {
                    points: self.list_points(Some(p.id))?,
                    plugin: p,
                })
            })
            .collect()
    }

    /// 用 Active 节点推送的配置快照整体替换本机插件/点位与关键 server_config。
    /// 在单个连接锁内事务执行，保证幂等。
    pub fn apply_config_snapshot(&self, snap: &ConfigSnapshot) -> anyhow::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM points", [])?;
        tx.execute("DELETE FROM plugins", [])?;
        for (key, value) in [
            ("scan_interval_ms", snap.scan_interval_ms.to_string()),
            ("batch_interval_ms", snap.batch_interval_ms.to_string()),
            ("plugin_dir", snap.plugin_dir.clone()),
            ("config_version", snap.config_version.to_string()),
            ("redundancy_config", snap.redundancy.to_string()),
        ] {
            tx.execute(
                "INSERT OR REPLACE INTO server_config(key,value) VALUES(?1,?2)",
                params![key, value],
            )?;
        }
        for pl in &snap.plugins {
            tx.execute(
                "INSERT INTO plugins(name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority)
                 VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    pl.name,
                    pl.wasm_file,
                    pl.config_json,
                    pl.enabled as i32,
                    pl.redundancy_group,
                    pl.redundancy_role,
                    pl.priority
                ],
            )?;
            let pid = tx.last_insert_rowid();
            for pt in &pl.points {
                tx.execute(
                    "INSERT INTO points(plugin_id,variable_id,address,data_type,byte_order,scale,offset_val,var_type,description)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        pid,
                        pt.variable_id,
                        pt.address,
                        pt.data_type,
                        pt.byte_order,
                        pt.scale,
                        pt.offset_val,
                        pt.var_type,
                        pt.description
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

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

    #[test]
    fn apply_config_snapshot_replaces_plugins_and_points() {
        let repo = Repo::new(":memory:").unwrap();
        let pid = repo.insert_plugin("old", "old.wasm", "{}").unwrap();
        repo.insert_point(pid, "P1", "a", "bool", "big_endian", 1.0, 0.0, "DI", "")
            .unwrap();

        let snap = ConfigSnapshot {
            config_version: 7,
            scan_interval_ms: 1000,
            batch_interval_ms: 200,
            plugin_dir: "./plugins".into(),
            redundancy: serde_json::json!({"enabled": true}),
            plugins: vec![SnapshotPlugin {
                name: "new".into(),
                wasm_file: "new.wasm".into(),
                config_json: "{}".into(),
                enabled: true,
                redundancy_group: "mb-link".into(),
                redundancy_role: "backup".into(),
                priority: 1,
                points: vec![SnapshotPoint {
                    variable_id: "P2".into(),
                    address: "b".into(),
                    data_type: "uint16".into(),
                    byte_order: "big_endian".into(),
                    scale: 1.0,
                    offset_val: 0.0,
                    var_type: "AI".into(),
                    description: String::new(),
                }],
            }],
        };
        repo.apply_config_snapshot(&snap).unwrap();

        let plugins = repo.list_plugins().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].name, "new");
        assert_eq!(plugins[0].redundancy_group, "mb-link");
        assert_eq!(plugins[0].redundancy_role, "backup");
        assert_eq!(plugins[0].priority, 1);
        let points = repo.list_points(None).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].variable_id, "P2");
        assert_eq!(repo.get_config("config_version").as_deref(), Some("7"));
        assert_eq!(repo.get_config("scan_interval_ms").as_deref(), Some("1000"));
    }

    #[test]
    fn plugin_row_round_trips_redundancy_fields() {
        let repo = Repo::new(":memory:").unwrap();
        let pid = repo
            .insert_plugin_full("mb1", "mb.wasm", "{}", "mb-link", "primary", 0)
            .unwrap();
        let p = repo.get_plugin(pid).unwrap().unwrap();
        assert_eq!(p.redundancy_group, "mb-link");
        assert_eq!(p.redundancy_role, "primary");
        assert_eq!(p.priority, 0);
        repo.update_plugin_full(pid, "mb1", "mb.wasm", "{}", "mb-link", "backup", 2, true)
            .unwrap();
        let p = repo.get_plugin(pid).unwrap().unwrap();
        assert_eq!(p.redundancy_role, "backup");
        assert_eq!(p.priority, 2);
    }
}
