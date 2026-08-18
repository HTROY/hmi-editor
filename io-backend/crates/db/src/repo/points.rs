//! Point CRUD (join with plugin rows for display metadata).

use super::{db_err, PluginWithPoints, PointRow, Repo};
use rusqlite::params;

/// Column list shared by every point query. Columns are aliased so row
/// mapping can use column names (the JOIN would otherwise produce ambiguous
/// `id`/`name` matches).
const POINT_SELECT: &str = "SELECT p.id AS id, p.plugin_id AS plugin_id, \
     p.variable_id AS variable_id, p.address AS address, p.data_type AS data_type, \
     p.byte_order AS byte_order, p.scale AS scale, p.offset_val AS offset_val, \
     p.var_type AS var_type, p.description AS description, pl.name AS plugin_name, \
     pl.redundancy_group AS redundancy_group, pl.redundancy_role AS redundancy_role \
     FROM points p JOIN plugins pl ON pl.id = p.plugin_id";

fn map_point(row: &rusqlite::Row) -> rusqlite::Result<PointRow> {
    Ok(PointRow {
        id: row.get("id")?,
        plugin_id: row.get("plugin_id")?,
        plugin_name: row.get("plugin_name")?,
        redundancy_group: row.get("redundancy_group")?,
        redundancy_role: row.get("redundancy_role")?,
        variable_id: row.get("variable_id")?,
        address: row.get("address")?,
        data_type: row.get("data_type")?,
        byte_order: row.get("byte_order")?,
        scale: row.get("scale")?,
        offset_val: row.get("offset_val")?,
        var_type: row.get("var_type")?,
        description: row.get::<_, String>("description").unwrap_or_default(),
    })
}

impl Repo {
    pub async fn list_points(&self, plugin_id: Option<i64>) -> anyhow::Result<Vec<PointRow>> {
        self.conn
            .call(move |conn| {
                let mut sql = conn.prepare(&format!(
                    "{} WHERE (?1 IS NULL OR p.plugin_id = ?1) ORDER BY p.plugin_id, p.id",
                    POINT_SELECT
                ))?;
                let rows: Vec<PointRow> = sql
                    .query_map(params![plugin_id], |r| map_point(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }
    pub async fn get_point(&self, id: i64) -> anyhow::Result<Option<PointRow>> {
        self.conn
            .call(move |conn| {
                let mut sql = conn.prepare(&format!("{} WHERE p.id=?1", POINT_SELECT))?;
                let mut rows = sql.query_map(params![id], |r| map_point(r))?;
                match rows.next() {
                    Some(Ok(r)) => Ok(Some(r)),
                    Some(Err(e)) => Err(e),
                    None => Ok(None),
                }
            })
            .await
            .map_err(db_err)
    }
    pub async fn insert_point(
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
        let var_id = var_id.to_owned();
        let addr = addr.to_owned();
        let dtype = dtype.to_owned();
        let border = border.to_owned();
        let vtype = vtype.to_owned();
        let description = description.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute("INSERT OR REPLACE INTO points(plugin_id,variable_id,address,data_type,byte_order,scale,offset_val,var_type,description) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![plugin_id, var_id, addr, dtype, border, scale, offset_val, vtype, description])?;
                Ok(conn.last_insert_rowid())
            })
            .await
            .map_err(db_err)
    }
    pub async fn update_point(
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
        let var_id = var_id.to_owned();
        let addr = addr.to_owned();
        let dtype = dtype.to_owned();
        let border = border.to_owned();
        let vtype = vtype.to_owned();
        let description = description.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute("UPDATE points SET variable_id=?2,address=?3,data_type=?4,byte_order=?5,scale=?6,offset_val=?7,var_type=?8,description=?9 WHERE id=?1", params![id, var_id, addr, dtype, border, scale, offset_val, vtype, description])?;
                Ok(())
            })
            .await
            .map_err(db_err)
    }
    pub async fn delete_point(&self, id: i64) -> anyhow::Result<()> {
        self.conn
            .call(move |conn| {
                conn.execute("DELETE FROM points WHERE id=?1", params![id])?;
                Ok(())
            })
            .await
            .map_err(db_err)
    }
    pub async fn list_plugins_with_points(&self) -> anyhow::Result<Vec<PluginWithPoints>> {
        let plugins = self.list_plugins().await?;
        let mut out = Vec::with_capacity(plugins.len());
        for p in plugins {
            let points = self.list_points(Some(p.id)).await?;
            out.push(PluginWithPoints { points, plugin: p });
        }
        Ok(out)
    }
}
