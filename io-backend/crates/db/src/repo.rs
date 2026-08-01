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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointRow {
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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginWithPoints {
    pub plugin: PluginRow,
    pub points: Vec<PointRow>,
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
    })
}
fn map_point(row: &rusqlite::Row) -> rusqlite::Result<PointRow> {
    Ok(PointRow {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
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
            conn.prepare("SELECT id,name,wasm_file,config_json,enabled FROM plugins ORDER BY id")?;
        let rows: Vec<PluginRow> = sql
            .query_map([], |r| map_plugin(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn get_plugin(&self, id: i64) -> anyhow::Result<Option<PluginRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql =
            conn.prepare("SELECT id,name,wasm_file,config_json,enabled FROM plugins WHERE id=?1")?;
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
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plugins(name,wasm_file,config_json) VALUES(?1,?2,?3)",
            params![name, wasm_file, config_json],
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
        self.conn.lock().unwrap().execute("UPDATE plugins SET name=?2,wasm_file=?3,config_json=?4,enabled=?5,updated_at=datetime('now') WHERE id=?1", params![id, name, wasm_file, config_json, enabled as i32])?;
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
        let mut sql = conn.prepare("SELECT id,plugin_id,variable_id,address,data_type,byte_order,scale,offset_val,var_type,description FROM points WHERE (?1 IS NULL OR plugin_id = ?1) ORDER BY plugin_id,id")?;
        let rows: Vec<PointRow> = sql
            .query_map(params![plugin_id], |r| map_point(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn get_point(&self, id: i64) -> anyhow::Result<Option<PointRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare("SELECT id,plugin_id,variable_id,address,data_type,byte_order,scale,offset_val,var_type,description FROM points WHERE id=?1")?;
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
}
