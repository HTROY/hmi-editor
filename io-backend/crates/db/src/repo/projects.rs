//! Project storage metadata and audit log.

use super::{db_err, AuditLogRow, ProjectPushResult, ProjectRow, Repo};
use rusqlite::{params, OptionalExtension};

fn map_project(row: &rusqlite::Row) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: row.get("id")?,
        name: row.get("name")?,
        schema_version: row.get("schema_version")?,
        version: row.get("version")?,
        size_bytes: row.get("size_bytes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_audit_log(row: &rusqlite::Row) -> rusqlite::Result<AuditLogRow> {
    Ok(AuditLogRow {
        id: row.get("id")?,
        action: row.get("action")?,
        project_id: row.get("project_id")?,
        project_name: row.get("project_name")?,
        version: row.get("version")?,
        actor: row.get("actor")?,
        detail: row.get("detail")?,
        created_at: row.get("created_at")?,
    })
}

impl Repo {
    pub async fn list_projects(&self) -> anyhow::Result<Vec<ProjectRow>> {
        self.conn
            .call(|conn| {
                let mut sql = conn.prepare(
                    "SELECT id,name,schema_version,version,size_bytes,created_at,updated_at
                     FROM projects ORDER BY updated_at DESC, id",
                )?;
                let rows: Vec<ProjectRow> = sql
                    .query_map([], |r| map_project(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }

    pub async fn get_project(&self, id: &str) -> anyhow::Result<Option<ProjectRow>> {
        let id = id.to_owned();
        self.conn
            .call(move |conn| {
                let mut sql = conn.prepare(
                    "SELECT id,name,schema_version,version,size_bytes,created_at,updated_at
                     FROM projects WHERE id=?1",
                )?;
                let mut rows = sql.query_map(params![id], |r| map_project(r))?;
                match rows.next() {
                    Some(Ok(r)) => Ok(Some(r)),
                    Some(Err(e)) => Err(e),
                    None => Ok(None),
                }
            })
            .await
            .map_err(db_err)
    }

    /// Insert or bump a project inside one transaction together with its
    /// audit entry. `expected_version` is the optimistic-lock check:
    /// - missing project: only `None`/`0` creates it (version starts at 1);
    /// - existing project: must equal the stored version, otherwise `Ok(None)`.
    pub async fn push_project(
        &self,
        id: &str,
        expected_version: Option<u64>,
        name: &str,
        schema_version: u32,
        size_bytes: u64,
        actor: &str,
        detail: &str,
    ) -> anyhow::Result<Option<ProjectPushResult>> {
        let id = id.to_owned();
        let name = name.to_owned();
        let actor = actor.to_owned();
        let detail = detail.to_owned();
        self.conn
            .call(move |conn| {
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
            })
            .await
            .map_err(db_err)
    }

    /// Delete a project row and write its audit entry atomically. Returns the
    /// deleted row (if any) so the caller can remove the disk package.
    pub async fn delete_project(
        &self,
        id: &str,
        actor: &str,
        detail: &str,
    ) -> anyhow::Result<Option<ProjectRow>> {
        let id = id.to_owned();
        let actor = actor.to_owned();
        let detail = detail.to_owned();
        self.conn
            .call(move |conn| {
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
            })
            .await
            .map_err(db_err)
    }

    pub async fn list_audit_logs(
        &self,
        project_id: Option<&str>,
    ) -> anyhow::Result<Vec<AuditLogRow>> {
        let project_id = project_id.map(str::to_owned);
        self.conn
            .call(move |conn| {
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
            })
            .await
            .map_err(db_err)
    }
}
