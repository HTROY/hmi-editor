//! Plugin CRUD.

use super::{db_err, PluginRow, Repo};
use rusqlite::params;

fn map_plugin(row: &rusqlite::Row) -> rusqlite::Result<PluginRow> {
    Ok(PluginRow {
        id: row.get("id")?,
        name: row.get("name")?,
        wasm_file: row.get("wasm_file")?,
        config_json: row.get("config_json")?,
        enabled: row.get::<_, i32>("enabled")? != 0,
        redundancy_group: row.get("redundancy_group")?,
        redundancy_role: row.get("redundancy_role")?,
        priority: row.get("priority")?,
    })
}

impl Repo {
    pub async fn list_plugins(&self) -> anyhow::Result<Vec<PluginRow>> {
        self.conn
            .call(|conn| {
                let mut sql = conn.prepare(
                    "SELECT id,name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority FROM plugins ORDER BY id",
                )?;
                let rows: Vec<PluginRow> = sql
                    .query_map([], |r| map_plugin(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }
    pub async fn get_plugin(&self, id: i64) -> anyhow::Result<Option<PluginRow>> {
        self.conn
            .call(move |conn| {
                let mut sql = conn.prepare(
                    "SELECT id,name,wasm_file,config_json,enabled,redundancy_group,redundancy_role,priority FROM plugins WHERE id=?1",
                )?;
                let mut rows = sql.query_map(params![id], |r| map_plugin(r))?;
                match rows.next() {
                    Some(Ok(r)) => Ok(Some(r)),
                    Some(Err(e)) => Err(e),
                    None => Ok(None),
                }
            })
            .await
            .map_err(db_err)
    }
    pub async fn insert_plugin(
        &self,
        name: &str,
        wasm_file: &str,
        config_json: &str,
    ) -> anyhow::Result<i64> {
        self.insert_plugin_full(name, wasm_file, config_json, "", "", 0)
            .await
    }

    pub async fn insert_plugin_full(
        &self,
        name: &str,
        wasm_file: &str,
        config_json: &str,
        redundancy_group: &str,
        redundancy_role: &str,
        priority: u32,
    ) -> anyhow::Result<i64> {
        let name = name.to_owned();
        let wasm_file = wasm_file.to_owned();
        let config_json = config_json.to_owned();
        let redundancy_group = redundancy_group.to_owned();
        let redundancy_role = redundancy_role.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO plugins(name,wasm_file,config_json,redundancy_group,redundancy_role,priority)
                     VALUES(?1,?2,?3,?4,?5,?6)",
                    params![name, wasm_file, config_json, redundancy_group, redundancy_role, priority],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .await
            .map_err(db_err)
    }
    pub async fn update_plugin(
        &self,
        id: i64,
        name: &str,
        wasm_file: &str,
        config_json: &str,
        enabled: bool,
    ) -> anyhow::Result<()> {
        self.update_plugin_full(id, name, wasm_file, config_json, "", "", 0, enabled)
            .await
    }

    pub async fn update_plugin_full(
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
        let name = name.to_owned();
        let wasm_file = wasm_file.to_owned();
        let config_json = config_json.to_owned();
        let redundancy_group = redundancy_group.to_owned();
        let redundancy_role = redundancy_role.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute(
                    "UPDATE plugins SET name=?2,wasm_file=?3,config_json=?4,redundancy_group=?5,redundancy_role=?6,priority=?7,enabled=?8,updated_at=datetime('now') WHERE id=?1",
                    params![id, name, wasm_file, config_json, redundancy_group, redundancy_role, priority, enabled as i32],
                )?;
                Ok(())
            })
            .await
            .map_err(db_err)
    }
    pub async fn delete_plugin(&self, id: i64) -> anyhow::Result<()> {
        self.conn
            .call(move |conn| {
                conn.execute("DELETE FROM plugins WHERE id=?1", params![id])?;
                Ok(())
            })
            .await
            .map_err(db_err)
    }
}
