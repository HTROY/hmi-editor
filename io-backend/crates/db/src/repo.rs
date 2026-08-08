//! Repository layer - thread-safe CRUD for plugins, points and users

use rusqlite::{params, Connection, OptionalExtension};
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
    pub alarm_retention_days: u32,
    pub soe_retention_days: u32,
    pub alarm_rules: Vec<SnapshotAlarmRule>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotAlarmRule {
    pub id: String,
    pub variable_id: String,
    pub name: String,
    pub description: String,
    pub severity: String,
    pub group_name: String,
    pub condition: String,
    pub threshold: f64,
    pub enabled: bool,
    pub hysteresis: f64,
    pub confirm_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmRuleRow {
    pub id: String,
    pub variable_id: String,
    pub name: String,
    pub description: String,
    pub severity: String,
    pub group_name: String,
    pub condition: String,
    pub threshold: f64,
    pub enabled: bool,
    pub hysteresis: f64,
    pub confirm_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmOccurrenceRow {
    pub id: String,
    pub rule_id: String,
    pub variable_id: String,
    pub name: String,
    pub severity: String,
    pub group_name: String,
    pub message: String,
    pub value: String,
    pub threshold: f64,
    pub status: String,
    pub triggered_at: u64,
    pub recovered_at: Option<u64>,
    pub recovered_reason: String,
    pub acknowledged_at: Option<u64>,
    pub acknowledged_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlarmStreamEventRow {
    pub id: i64,
    pub occurrence_id: String,
    pub event_type: String,
    pub at_ms: u64,
    pub by_user: String,
    pub value: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoeRow {
    pub id: i64,
    pub seq: i64,
    pub variable_id: String,
    pub value: String,
    pub quality: String,
    pub device_time: u64,
    pub receive_time: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub schema_version: u32,
    pub version: u64,
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogRow {
    pub id: i64,
    pub action: String,
    pub project_id: String,
    pub project_name: String,
    pub version: u64,
    pub actor: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub must_change_password: bool,
    pub token_version: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPushResult {
    pub created: bool,
    pub version: u64,
}

pub struct Repo {
    conn: Mutex<Connection>,
}

fn map_alarm_rule(row: &rusqlite::Row) -> rusqlite::Result<AlarmRuleRow> {
    Ok(AlarmRuleRow {
        id: row.get(0)?,
        variable_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        severity: row.get(4)?,
        group_name: row.get(5)?,
        condition: row.get(6)?,
        threshold: row.get(7)?,
        enabled: row.get::<_, i32>(8)? != 0,
        hysteresis: row.get(9)?,
        confirm_ms: row.get(10)?,
    })
}

fn map_alarm_occurrence(row: &rusqlite::Row) -> rusqlite::Result<AlarmOccurrenceRow> {
    Ok(AlarmOccurrenceRow {
        id: row.get(0)?,
        rule_id: row.get(1)?,
        variable_id: row.get(2)?,
        name: row.get(3)?,
        severity: row.get(4)?,
        group_name: row.get(5)?,
        message: row.get(6)?,
        value: row.get(7)?,
        threshold: row.get(8)?,
        status: row.get(9)?,
        triggered_at: row.get(10)?,
        recovered_at: row.get(11)?,
        recovered_reason: row.get(12)?,
        acknowledged_at: row.get(13)?,
        acknowledged_by: row.get(14)?,
    })
}

fn map_stream_event(row: &rusqlite::Row) -> rusqlite::Result<AlarmStreamEventRow> {
    Ok(AlarmStreamEventRow {
        id: row.get(0)?,
        occurrence_id: row.get(1)?,
        event_type: row.get(2)?,
        at_ms: row.get(3)?,
        by_user: row.get(4)?,
        value: row.get(5)?,
        message: row.get(6)?,
    })
}

fn map_soe(row: &rusqlite::Row) -> rusqlite::Result<SoeRow> {
    Ok(SoeRow {
        id: row.get(0)?,
        seq: row.get(1)?,
        variable_id: row.get(2)?,
        value: row.get(3)?,
        quality: row.get(4)?,
        device_time: row.get(5)?,
        receive_time: row.get(6)?,
        source: row.get(7)?,
    })
}

fn map_project(row: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: row.get(0)?,
        name: row.get(1)?,
        schema_version: row.get(2)?,
        version: row.get(3)?,
        size_bytes: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn map_audit_log(row: &rusqlite::Row) -> rusqlite::Result<AuditLogRow> {
    Ok(AuditLogRow {
        id: row.get(0)?,
        action: row.get(1)?,
        project_id: row.get(2)?,
        project_name: row.get(3)?,
        version: row.get(4)?,
        actor: row.get(5)?,
        detail: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn map_user(row: &rusqlite::Row) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        password_hash: row.get(2)?,
        role: row.get(3)?,
        must_change_password: row.get(4)?,
        token_version: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
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

    // ---- Project storage metadata & audit ----

    pub fn list_projects(&self) -> anyhow::Result<Vec<ProjectRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,name,schema_version,version,size_bytes,created_at,updated_at
             FROM projects ORDER BY updated_at DESC, id",
        )?;
        let rows: Vec<ProjectRow> = sql
            .query_map([], |r| map_project(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_project(&self, id: &str) -> anyhow::Result<Option<ProjectRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,name,schema_version,version,size_bytes,created_at,updated_at
             FROM projects WHERE id=?1",
        )?;
        let mut rows = sql.query_map(params![id], |r| map_project(r))?;
        match rows.next() {
            Some(Ok(r)) => Ok(Some(r)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }

    /// Insert or bump a project inside one transaction together with its
    /// audit entry. `expected_version` is the optimistic-lock check:
    /// - missing project: only `None`/`0` creates it (version starts at 1);
    /// - existing project: must equal the stored version, otherwise `Ok(None)`.
    pub fn push_project(
        &self,
        id: &str,
        expected_version: Option<u64>,
        name: &str,
        schema_version: u32,
        size_bytes: u64,
        actor: &str,
        detail: &str,
    ) -> anyhow::Result<Option<ProjectPushResult>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let existing: Option<ProjectRow> = tx
            .query_row(
                "SELECT id,name,schema_version,version,size_bytes,created_at,updated_at
                 FROM projects WHERE id=?1",
                params![id],
                map_project,
            )
            .optional()?;
        let result = match existing {
            None => {
                if expected_version.unwrap_or(0) != 0 {
                    return Ok(None);
                }
                tx.execute(
                    "INSERT INTO projects(id,name,schema_version,version,size_bytes)
                     VALUES(?1,?2,?3,1,?4)",
                    params![id, name, schema_version, size_bytes],
                )?;
                tx.execute(
                    "INSERT INTO project_audit_log(action,project_id,project_name,version,actor,detail)
                     VALUES('project_push',?1,?2,1,?3,?4)",
                    params![id, name, actor, detail],
                )?;
                ProjectPushResult {
                    created: true,
                    version: 1,
                }
            }
            Some(current) => {
                let expected = match expected_version {
                    Some(v) => v,
                    None => return Ok(None),
                };
                if expected != current.version {
                    return Ok(None);
                }
                let new_version = current.version + 1;
                let updated = tx.execute(
                    "UPDATE projects SET name=?2,schema_version=?3,version=?4,size_bytes=?5,updated_at=datetime('now')
                     WHERE id=?1 AND version=?6",
                    params![id, name, schema_version, new_version, size_bytes, expected],
                )?;
                if updated != 1 {
                    return Ok(None);
                }
                tx.execute(
                    "INSERT INTO project_audit_log(action,project_id,project_name,version,actor,detail)
                     VALUES('project_push',?1,?2,?3,?4,?5)",
                    params![id, name, new_version, actor, detail],
                )?;
                ProjectPushResult {
                    created: false,
                    version: new_version,
                }
            }
        };
        tx.commit()?;
        Ok(Some(result))
    }

    /// Delete a project row and write its audit entry atomically. Returns the
    /// deleted row (if any) so the caller can remove the disk package.
    pub fn delete_project(
        &self,
        id: &str,
        actor: &str,
        detail: &str,
    ) -> anyhow::Result<Option<ProjectRow>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let existing: Option<ProjectRow> = tx
            .query_row(
                "SELECT id,name,schema_version,version,size_bytes,created_at,updated_at
                 FROM projects WHERE id=?1",
                params![id],
                map_project,
            )
            .optional()?;
        if let Some(row) = &existing {
            tx.execute("DELETE FROM projects WHERE id=?1", params![id])?;
            tx.execute(
                "INSERT INTO project_audit_log(action,project_id,project_name,version,actor,detail)
                 VALUES('project_delete',?1,?2,?3,?4,?5)",
                params![id, row.name, row.version, actor, detail],
            )?;
        }
        tx.commit()?;
        Ok(existing)
    }

    pub fn list_audit_logs(&self, project_id: Option<&str>) -> anyhow::Result<Vec<AuditLogRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,action,project_id,project_name,version,actor,detail,created_at
             FROM project_audit_log
             WHERE (?1 IS NULL OR project_id=?1)
             ORDER BY id",
        )?;
        let rows: Vec<AuditLogRow> = sql
            .query_map(params![project_id], |r| map_audit_log(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- Users ----

    pub fn create_user(
        &self,
        username: &str,
        password_hash: &str,
        role: &str,
        must_change_password: bool,
    ) -> anyhow::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users(username,password_hash,role,must_change_password)
             VALUES(?1,?2,?3,?4)",
            params![username, password_hash, role, must_change_password],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_user(&self, username: &str) -> anyhow::Result<Option<UserRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,username,password_hash,role,must_change_password,token_version,created_at,updated_at
             FROM users WHERE username=?1",
        )?;
        let mut rows = sql.query_map(params![username], |r| map_user(r))?;
        match rows.next() {
            Some(Ok(row)) => Ok(Some(row)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }

    pub fn update_user_password(
        &self,
        username: &str,
        password_hash: &str,
        must_change_password: bool,
    ) -> anyhow::Result<u64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET password_hash=?2, must_change_password=?3,
             token_version=token_version+1, updated_at=datetime('now')
             WHERE username=?1",
            params![username, password_hash, must_change_password],
        )?;
        let version: u64 = conn.query_row(
            "SELECT token_version FROM users WHERE username=?1",
            params![username],
            |r| r.get(0),
        )?;
        Ok(version)
    }

    pub fn user_count(&self) -> anyhow::Result<i64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        Ok(count)
    }

    /// 用 Active 节点推送的配置快照整体替换本机插件/点位与关键 server_config。
    /// 在单个连接锁内事务执行，保证幂等。
    pub fn apply_config_snapshot(&self, snap: &ConfigSnapshot) -> anyhow::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM points", [])?;
        tx.execute("DELETE FROM plugins", [])?;
        tx.execute("DELETE FROM alarm_rules", [])?;
        for (key, value) in [
            ("scan_interval_ms", snap.scan_interval_ms.to_string()),
            ("batch_interval_ms", snap.batch_interval_ms.to_string()),
            ("plugin_dir", snap.plugin_dir.clone()),
            ("config_version", snap.config_version.to_string()),
            ("redundancy_config", snap.redundancy.to_string()),
            (
                "alarm_retention_days",
                snap.alarm_retention_days.to_string(),
            ),
            ("soe_retention_days", snap.soe_retention_days.to_string()),
        ] {
            tx.execute(
                "INSERT OR REPLACE INTO server_config(key,value) VALUES(?1,?2)",
                params![key, value],
            )?;
        }
        for rule in &snap.alarm_rules {
            tx.execute(
                "INSERT INTO alarm_rules(id,variable_id,name,description,severity,group_name,condition,threshold,enabled,hysteresis,confirm_ms)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![
                    rule.id,
                    rule.variable_id,
                    rule.name,
                    rule.description,
                    rule.severity,
                    rule.group_name,
                    rule.condition,
                    rule.threshold,
                    rule.enabled as i32,
                    rule.hysteresis,
                    rule.confirm_ms
                ],
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

    // ---- Alarm / SOE persistence ----

    pub fn list_alarm_rules(&self) -> anyhow::Result<Vec<AlarmRuleRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,variable_id,name,description,severity,group_name,condition,threshold,enabled,hysteresis,confirm_ms
             FROM alarm_rules ORDER BY id",
        )?;
        let rows: Vec<AlarmRuleRow> = sql
            .query_map([], |r| map_alarm_rule(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn insert_alarm_rule(&self, r: &AlarmRuleRow) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO alarm_rules(id,variable_id,name,description,severity,group_name,condition,threshold,enabled,hysteresis,confirm_ms,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,datetime('now'))",
            params![
                r.id,
                r.variable_id,
                r.name,
                r.description,
                r.severity,
                r.group_name,
                r.condition,
                r.threshold,
                r.enabled as i32,
                r.hysteresis,
                r.confirm_ms
            ],
        )?;
        Ok(())
    }

    pub fn delete_alarm_rule(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM alarm_rules WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn upsert_alarm_occurrence(&self, o: &AlarmOccurrenceRow) -> anyhow::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT OR REPLACE INTO alarm_occurrences(id,rule_id,variable_id,name,severity,group_name,message,value,threshold,status,triggered_at,recovered_at,recovered_reason,acknowledged_at,acknowledged_by)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                o.id,
                o.rule_id,
                o.variable_id,
                o.name,
                o.severity,
                o.group_name,
                o.message,
                o.value,
                o.threshold,
                o.status,
                o.triggered_at,
                o.recovered_at,
                o.recovered_reason,
                o.acknowledged_at,
                o.acknowledged_by
            ],
        )?;
        Ok(())
    }

    pub fn insert_alarm_stream_event(&self, e: &mut AlarmStreamEventRow) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO alarm_stream_events(occurrence_id,event_type,at_ms,by_user,value,message)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                e.occurrence_id,
                e.event_type,
                e.at_ms,
                e.by_user,
                e.value,
                e.message
            ],
        )?;
        e.id = conn.last_insert_rowid();
        Ok(())
    }

    pub fn insert_soe(&self, s: &mut SoeRow) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO soe_events(seq,variable_id,value,quality,device_time,receive_time,source)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                s.seq,
                s.variable_id,
                s.value,
                s.quality,
                s.device_time,
                s.receive_time,
                s.source
            ],
        )?;
        s.id = conn.last_insert_rowid();
        Ok(())
    }

    pub fn max_soe_seq(&self) -> i64 {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT COALESCE(MAX(seq),0) FROM soe_events", [], |r| {
                r.get(0)
            })
            .unwrap_or(0)
    }

    pub fn list_active_alarm_occurrences(&self) -> anyhow::Result<Vec<AlarmOccurrenceRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,rule_id,variable_id,name,severity,group_name,message,value,threshold,status,triggered_at,recovered_at,recovered_reason,acknowledged_at,acknowledged_by
             FROM alarm_occurrences WHERE status IN ('active','acknowledged')
             ORDER BY triggered_at DESC",
        )?;
        let rows: Vec<AlarmOccurrenceRow> = sql
            .query_map([], |r| map_alarm_occurrence(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_recovered_unacked(&self) -> anyhow::Result<Vec<AlarmOccurrenceRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,rule_id,variable_id,name,severity,group_name,message,value,threshold,status,triggered_at,recovered_at,recovered_reason,acknowledged_at,acknowledged_by
             FROM alarm_occurrences WHERE status='recovered' AND acknowledged_at IS NULL
             ORDER BY triggered_at DESC",
        )?;
        let rows: Vec<AlarmOccurrenceRow> = sql
            .query_map([], |r| map_alarm_occurrence(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn query_alarm_occurrences(
        &self,
        from: Option<u64>,
        to: Option<u64>,
        severity: Option<&str>,
        group: Option<&str>,
        variable_id: Option<&str>,
        status: Option<&str>,
        page: u64,
        page_size: u64,
    ) -> anyhow::Result<(u64, Vec<AlarmOccurrenceRow>)> {
        let mut conds: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if let Some(v) = from {
            conds.push(format!("triggered_at >= ?{}", args.len() + 1));
            args.push(Box::new(v));
        }
        if let Some(v) = to {
            conds.push(format!("triggered_at <= ?{}", args.len() + 1));
            args.push(Box::new(v));
        }
        if let Some(v) = severity {
            conds.push(format!("severity = ?{}", args.len() + 1));
            args.push(Box::new(v.to_string()));
        }
        if let Some(v) = group {
            conds.push(format!("group_name = ?{}", args.len() + 1));
            args.push(Box::new(v.to_string()));
        }
        if let Some(v) = variable_id {
            conds.push(format!("variable_id = ?{}", args.len() + 1));
            args.push(Box::new(v.to_string()));
        }
        if let Some(v) = status {
            match v {
                // 按确认状态过滤：已确认 = 存在确认时间（无论是否已恢复）
                "acknowledged" => {
                    conds.push("acknowledged_at IS NOT NULL".to_string());
                }
                // 未确认 = 尚无确认时间（含活跃未确认与恢复后未确认）
                "unacknowledged" => {
                    conds.push("acknowledged_at IS NULL".to_string());
                }
                _ => {
                    conds.push(format!("status = ?{}", args.len() + 1));
                    args.push(Box::new(v.to_string()));
                }
            }
        }
        let where_sql = if conds.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conds.join(" AND "))
        };
        let page = page.max(1);
        let page_size = page_size.clamp(1, 500);
        let conn = self.conn.lock().unwrap();
        let total: u64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM alarm_occurrences{}", where_sql),
                rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
                |r| r.get(0),
            )?;
        let offset = (page - 1) * page_size;
        let limit_pos = args.len() + 1;
        let offset_pos = args.len() + 2;
        let mut sql = conn.prepare(&format!(
            "SELECT id,rule_id,variable_id,name,severity,group_name,message,value,threshold,status,triggered_at,recovered_at,recovered_reason,acknowledged_at,acknowledged_by
             FROM alarm_occurrences{} ORDER BY triggered_at DESC LIMIT ?{} OFFSET ?{}",
            where_sql, limit_pos, offset_pos
        ))?;
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = args;
        params.push(Box::new(page_size));
        params.push(Box::new(offset));
        let rows: Vec<AlarmOccurrenceRow> = sql
            .query_map(rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())), |r| {
                map_alarm_occurrence(r)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((total, rows))
    }

    pub fn query_occurrence_stream_events(
        &self,
        occurrence_id: &str,
    ) -> anyhow::Result<Vec<AlarmStreamEventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut sql = conn.prepare(
            "SELECT id,occurrence_id,event_type,at_ms,by_user,value,message
             FROM alarm_stream_events WHERE occurrence_id=?1 ORDER BY id",
        )?;
        let rows: Vec<AlarmStreamEventRow> = sql
            .query_map(params![occurrence_id], |r| map_stream_event(r))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn query_soe(
        &self,
        from: Option<u64>,
        to: Option<u64>,
        variable_id: Option<&str>,
        quality: Option<&str>,
        page: u64,
        page_size: u64,
    ) -> anyhow::Result<(u64, Vec<SoeRow>)> {
        let mut conds: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if let Some(v) = from {
            conds.push(format!("receive_time >= ?{}", args.len() + 1));
            args.push(Box::new(v));
        }
        if let Some(v) = to {
            conds.push(format!("receive_time <= ?{}", args.len() + 1));
            args.push(Box::new(v));
        }
        if let Some(v) = variable_id {
            conds.push(format!("variable_id = ?{}", args.len() + 1));
            args.push(Box::new(v.to_string()));
        }
        if let Some(v) = quality {
            conds.push(format!("quality = ?{}", args.len() + 1));
            args.push(Box::new(v.to_string()));
        }
        let where_sql = if conds.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conds.join(" AND "))
        };
        let page = page.max(1);
        let page_size = page_size.clamp(1, 500);
        let conn = self.conn.lock().unwrap();
        let total: u64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM soe_events{}", where_sql),
                rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
                |r| r.get(0),
            )?;
        let offset = (page - 1) * page_size;
        let limit_pos = args.len() + 1;
        let offset_pos = args.len() + 2;
        let mut sql = conn.prepare(&format!(
            "SELECT id,seq,variable_id,value,quality,device_time,receive_time,source
             FROM soe_events{} ORDER BY seq DESC LIMIT ?{} OFFSET ?{}",
            where_sql, limit_pos, offset_pos
        ))?;
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = args;
        params.push(Box::new(page_size));
        params.push(Box::new(offset));
        let rows: Vec<SoeRow> = sql
            .query_map(rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())), |r| {
                map_soe(r)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((total, rows))
    }

    /// Prune alarm history and SOE older than the retention windows.
    /// Returns (alarm_rows_deleted, soe_rows_deleted).
    pub fn prune_alarm_data(&self, alarm_days: u64, soe_days: u64) -> anyhow::Result<(u64, u64)> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let alarm_cutoff = now_ms.saturating_sub(alarm_days.saturating_mul(86_400_000));
        let soe_cutoff = now_ms.saturating_sub(soe_days.saturating_mul(86_400_000));
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let deleted_occ = tx.execute(
            "DELETE FROM alarm_occurrences WHERE status='recovered' AND recovered_at IS NOT NULL AND recovered_at < ?1",
            params![alarm_cutoff],
        )? as u64;
        // Remove stream events whose occurrence is gone.
        tx.execute(
            "DELETE FROM alarm_stream_events WHERE occurrence_id NOT IN (SELECT id FROM alarm_occurrences)",
            [],
        )?;
        let deleted_soe =
            tx.execute("DELETE FROM soe_events WHERE receive_time < ?1", params![soe_cutoff])?
                as u64;
        tx.commit()?;
        Ok((deleted_occ, deleted_soe))
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
            alarm_retention_days: 90,
            soe_retention_days: 30,
            alarm_rules: vec![SnapshotAlarmRule {
                id: "ALM_1".into(),
                variable_id: "P2".into(),
                name: "test".into(),
                description: String::new(),
                severity: "warning".into(),
                group_name: "g".into(),
                condition: "high".into(),
                threshold: 10.0,
                enabled: true,
                hysteresis: 0.0,
                confirm_ms: 0,
            }],
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

    #[test]
    fn alarm_history_ack_filter_matches_acknowledgement_state() {
        let repo = Repo::new(":memory:").unwrap();
        let mut row = AlarmOccurrenceRow {
            id: String::new(),
            rule_id: "R1".into(),
            variable_id: "P1".into(),
            name: "test".into(),
            severity: "major".into(),
            group_name: "g".into(),
            message: "m".into(),
            value: "1".into(),
            threshold: 0.0,
            status: "active".into(),
            triggered_at: 100,
            recovered_at: None,
            recovered_reason: String::new(),
            acknowledged_at: None,
            acknowledged_by: String::new(),
        };

        row.id = "OCC_ACTIVE_UNACK".into();
        repo.upsert_alarm_occurrence(&row).unwrap();

        row.id = "OCC_ACTIVE_ACK".into();
        row.status = "acknowledged".into();
        row.acknowledged_at = Some(200);
        row.acknowledged_by = "op".into();
        repo.upsert_alarm_occurrence(&row).unwrap();

        row.id = "OCC_RECOVERED_ACK".into();
        row.status = "recovered".into();
        row.recovered_at = Some(300);
        repo.upsert_alarm_occurrence(&row).unwrap();

        row.id = "OCC_RECOVERED_UNACK".into();
        row.status = "recovered".into();
        row.acknowledged_at = None;
        row.acknowledged_by = String::new();
        repo.upsert_alarm_occurrence(&row).unwrap();

        let (total_ack, rows_ack) = repo
            .query_alarm_occurrences(None, None, None, None, None, Some("acknowledged"), 1, 10)
            .unwrap();
        assert_eq!(total_ack, 2);
        let ack_ids: Vec<&str> = rows_ack.iter().map(|r| r.id.as_str()).collect();
        assert!(ack_ids.contains(&"OCC_ACTIVE_ACK"));
        assert!(ack_ids.contains(&"OCC_RECOVERED_ACK"));

        let (total_unack, _) = repo
            .query_alarm_occurrences(None, None, None, None, None, Some("unacknowledged"), 1, 10)
            .unwrap();
        assert_eq!(total_unack, 2);

        let (total_recovered, _) = repo
            .query_alarm_occurrences(None, None, None, None, None, Some("recovered"), 1, 10)
            .unwrap();
        assert_eq!(total_recovered, 2);
    }

    #[test]
    fn project_push_creates_then_bumps_with_optimistic_lock() {
        let repo = Repo::new(":memory:").unwrap();
        let res = repo
            .push_project("proj-1", None, "Line 1", 1, 123, "", "create")
            .unwrap()
            .unwrap();
        assert!(res.created);
        assert_eq!(res.version, 1);

        let row = repo.get_project("proj-1").unwrap().unwrap();
        assert_eq!(row.name, "Line 1");
        assert_eq!(row.schema_version, 1);
        assert_eq!(row.version, 1);
        assert_eq!(row.size_bytes, 123);

        let res = repo
            .push_project("proj-1", Some(1), "Line 1 v2", 1, 200, "alice", "update")
            .unwrap()
            .unwrap();
        assert!(!res.created);
        assert_eq!(res.version, 2);

        // Stale version, missing version, and create-with-nonzero-version all lose the lock.
        assert!(repo
            .push_project("proj-1", Some(1), "stale", 1, 1, "", "")
            .unwrap()
            .is_none());
        assert!(repo
            .push_project("proj-1", None, "no-version", 1, 1, "", "")
            .unwrap()
            .is_none());
        assert!(repo
            .push_project("missing", Some(3), "x", 1, 1, "", "")
            .unwrap()
            .is_none());

        let audit = repo.list_audit_logs(Some("proj-1")).unwrap();
        assert_eq!(audit.len(), 2);
        assert!(audit.iter().all(|e| e.action == "project_push"));
        assert_eq!(audit[0].version, 1);
        assert_eq!(audit[1].version, 2);
    }

    #[test]
    fn project_delete_writes_audit_and_returns_row() {
        let repo = Repo::new(":memory:").unwrap();
        repo.push_project("proj-2", None, "P2", 1, 10, "", "create")
            .unwrap();

        let deleted = repo
            .delete_project("proj-2", "op", "user removed")
            .unwrap()
            .unwrap();
        assert_eq!(deleted.id, "proj-2");
        assert_eq!(deleted.version, 1);
        assert!(repo.get_project("proj-2").unwrap().is_none());
        assert!(repo.delete_project("proj-2", "", "").unwrap().is_none());

        let audit = repo.list_audit_logs(Some("proj-2")).unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].action, "project_push");
        assert_eq!(audit[1].action, "project_delete");
        assert_eq!(audit[1].actor, "op");
    }

    #[test]
    fn user_create_and_get_round_trips_role_and_must_change() {
        let repo = Repo::new(":memory:").unwrap();
        let id = repo
            .create_user(
                "admin",
                "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash",
                "admin",
                true,
            )
            .unwrap();
        assert!(id > 0);

        let user = repo.get_user("admin").unwrap().unwrap();
        assert_eq!(user.username, "admin");
        assert_eq!(
            user.password_hash,
            "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash"
        );
        assert_eq!(user.role, "admin");
        assert!(user.must_change_password);

        assert!(repo.get_user("missing").unwrap().is_none());
    }

    #[test]
    fn update_user_password_replaces_hash_and_clears_must_change() {
        let repo = Repo::new(":memory:").unwrap();
        repo.create_user("engineer", "old-hash", "engineer", true)
            .unwrap();

        repo.update_user_password("engineer", "new-hash", false)
            .unwrap();

        let user = repo.get_user("engineer").unwrap().unwrap();
        assert_eq!(user.password_hash, "new-hash");
        assert!(!user.must_change_password);
        assert_eq!(user.token_version, 2);
    }

    #[test]
    fn user_count_starts_zero_and_tracks_rows() {
        let repo = Repo::new(":memory:").unwrap();
        assert_eq!(repo.user_count().unwrap(), 0);
        repo.create_user("op", "h", "operator", false).unwrap();
        repo.create_user("viewer", "h", "viewer", false).unwrap();
        assert_eq!(repo.user_count().unwrap(), 2);
    }
}
