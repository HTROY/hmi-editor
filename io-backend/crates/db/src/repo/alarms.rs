//! Alarm / SOE persistence.

use super::{db_err, AlarmOccurrenceRow, AlarmRuleRow, AlarmStreamEventRow, Repo, SoeRow};
use rusqlite::params;

fn map_alarm_rule(row: &rusqlite::Row) -> rusqlite::Result<AlarmRuleRow> {
    Ok(AlarmRuleRow {
        id: row.get("id")?,
        variable_id: row.get("variable_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        severity: row.get("severity")?,
        group_name: row.get("group_name")?,
        condition: row.get("condition")?,
        threshold: row.get("threshold")?,
        enabled: row.get::<_, i32>("enabled")? != 0,
        hysteresis: row.get("hysteresis")?,
        confirm_ms: row.get("confirm_ms")?,
    })
}

fn map_alarm_occurrence(row: &rusqlite::Row) -> rusqlite::Result<AlarmOccurrenceRow> {
    Ok(AlarmOccurrenceRow {
        id: row.get("id")?,
        rule_id: row.get("rule_id")?,
        variable_id: row.get("variable_id")?,
        name: row.get("name")?,
        severity: row.get("severity")?,
        group_name: row.get("group_name")?,
        message: row.get("message")?,
        value: row.get("value")?,
        threshold: row.get("threshold")?,
        status: row.get("status")?,
        triggered_at: row.get("triggered_at")?,
        recovered_at: row.get("recovered_at")?,
        recovered_reason: row.get("recovered_reason")?,
        acknowledged_at: row.get("acknowledged_at")?,
        acknowledged_by: row.get("acknowledged_by")?,
    })
}

fn map_stream_event(row: &rusqlite::Row) -> rusqlite::Result<AlarmStreamEventRow> {
    Ok(AlarmStreamEventRow {
        id: row.get("id")?,
        occurrence_id: row.get("occurrence_id")?,
        event_type: row.get("event_type")?,
        at_ms: row.get("at_ms")?,
        by_user: row.get("by_user")?,
        value: row.get("value")?,
        message: row.get("message")?,
    })
}

fn map_soe(row: &rusqlite::Row) -> rusqlite::Result<SoeRow> {
    Ok(SoeRow {
        id: row.get("id")?,
        seq: row.get("seq")?,
        variable_id: row.get("variable_id")?,
        value: row.get("value")?,
        quality: row.get("quality")?,
        device_time: row.get("device_time")?,
        receive_time: row.get("receive_time")?,
        source: row.get("source")?,
    })
}

impl Repo {
    pub async fn list_alarm_rules(&self) -> anyhow::Result<Vec<AlarmRuleRow>> {
        self.conn
            .call(|conn| {
                let mut sql = conn.prepare(
                    "SELECT id,variable_id,name,description,severity,group_name,condition,threshold,enabled,hysteresis,confirm_ms
                     FROM alarm_rules ORDER BY id",
                )?;
                let rows: Vec<AlarmRuleRow> = sql
                    .query_map([], |r| map_alarm_rule(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }

    pub async fn insert_alarm_rule(&self, r: &AlarmRuleRow) -> anyhow::Result<()> {
        let r = r.clone();
        self.conn
            .call(move |conn| {
                conn.execute(
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
            })
            .await
            .map_err(db_err)
    }

    pub async fn delete_alarm_rule(&self, id: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute("DELETE FROM alarm_rules WHERE id=?1", params![id])?;
                Ok(())
            })
            .await
            .map_err(db_err)
    }

    pub async fn upsert_alarm_occurrence(&self, o: &AlarmOccurrenceRow) -> anyhow::Result<()> {
        let o = o.clone();
        self.conn
            .call(move |conn| {
                conn.execute(
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
            })
            .await
            .map_err(db_err)
    }

    pub async fn insert_alarm_stream_event(
        &self,
        e: &mut AlarmStreamEventRow,
    ) -> anyhow::Result<()> {
        let occurrence_id = e.occurrence_id.clone();
        let event_type = e.event_type.clone();
        let at_ms = e.at_ms;
        let by_user = e.by_user.clone();
        let value = e.value.clone();
        let message = e.message.clone();
        let id = self
            .conn
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO alarm_stream_events(occurrence_id,event_type,at_ms,by_user,value,message)
                     VALUES(?1,?2,?3,?4,?5,?6)",
                    params![occurrence_id, event_type, at_ms, by_user, value, message],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .await
            .map_err(db_err)?;
        e.id = id;
        Ok(())
    }

    pub async fn insert_soe(&self, s: &mut SoeRow) -> anyhow::Result<()> {
        let seq = s.seq;
        let variable_id = s.variable_id.clone();
        let value = s.value.clone();
        let quality = s.quality.clone();
        let device_time = s.device_time;
        let receive_time = s.receive_time;
        let source = s.source.clone();
        let id = self
            .conn
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO soe_events(seq,variable_id,value,quality,device_time,receive_time,source)
                     VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![seq, variable_id, value, quality, device_time, receive_time, source],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .await
            .map_err(db_err)?;
        s.id = id;
        Ok(())
    }

    pub async fn max_soe_seq(&self) -> i64 {
        self.conn
            .call(|conn| {
                conn.query_row("SELECT COALESCE(MAX(seq),0) FROM soe_events", [], |r| {
                    r.get(0)
                })
            })
            .await
            .unwrap_or(0)
    }

    pub async fn list_active_alarm_occurrences(&self) -> anyhow::Result<Vec<AlarmOccurrenceRow>> {
        self.conn
            .call(|conn| {
                let mut sql = conn.prepare(
                    "SELECT id,rule_id,variable_id,name,severity,group_name,message,value,threshold,status,triggered_at,recovered_at,recovered_reason,acknowledged_at,acknowledged_by
                     FROM alarm_occurrences WHERE status IN ('active','acknowledged')
                     ORDER BY triggered_at DESC",
                )?;
                let rows: Vec<AlarmOccurrenceRow> = sql
                    .query_map([], |r| map_alarm_occurrence(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }

    pub async fn list_recovered_unacked(&self) -> anyhow::Result<Vec<AlarmOccurrenceRow>> {
        self.conn
            .call(|conn| {
                let mut sql = conn.prepare(
                    "SELECT id,rule_id,variable_id,name,severity,group_name,message,value,threshold,status,triggered_at,recovered_at,recovered_reason,acknowledged_at,acknowledged_by
                     FROM alarm_occurrences WHERE status='recovered' AND acknowledged_at IS NULL
                     ORDER BY triggered_at DESC",
                )?;
                let rows: Vec<AlarmOccurrenceRow> = sql
                    .query_map([], |r| map_alarm_occurrence(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn query_alarm_occurrences(
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
        let mut args: Vec<Box<dyn rusqlite::types::ToSql + Send>> = Vec::new();
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
        self.conn
            .call(move |conn| {
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
                let mut params: Vec<Box<dyn rusqlite::types::ToSql + Send>> = args;
                params.push(Box::new(page_size));
                params.push(Box::new(offset));
                let rows: Vec<AlarmOccurrenceRow> = sql
                    .query_map(rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())), |r| {
                        map_alarm_occurrence(r)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((total, rows))
            })
            .await
            .map_err(db_err)
    }

    pub async fn query_occurrence_stream_events(
        &self,
        occurrence_id: &str,
    ) -> anyhow::Result<Vec<AlarmStreamEventRow>> {
        let occurrence_id = occurrence_id.to_owned();
        self.conn
            .call(move |conn| {
                let mut sql = conn.prepare(
                    "SELECT id,occurrence_id,event_type,at_ms,by_user,value,message
                     FROM alarm_stream_events WHERE occurrence_id=?1 ORDER BY id",
                )?;
                let rows: Vec<AlarmStreamEventRow> = sql
                    .query_map(params![occurrence_id], |r| map_stream_event(r))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .await
            .map_err(db_err)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn query_soe(
        &self,
        from: Option<u64>,
        to: Option<u64>,
        variable_id: Option<&str>,
        quality: Option<&str>,
        page: u64,
        page_size: u64,
    ) -> anyhow::Result<(u64, Vec<SoeRow>)> {
        let mut conds: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::types::ToSql + Send>> = Vec::new();
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
        self.conn
            .call(move |conn| {
                let total: u64 = conn.query_row(
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
                let mut params: Vec<Box<dyn rusqlite::types::ToSql + Send>> = args;
                params.push(Box::new(page_size));
                params.push(Box::new(offset));
                let rows: Vec<SoeRow> = sql
                    .query_map(
                        rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
                        |r| map_soe(r),
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((total, rows))
            })
            .await
            .map_err(db_err)
    }

    /// Prune alarm history and SOE older than the retention windows.
    /// Returns (alarm_rows_deleted, soe_rows_deleted).
    pub async fn prune_alarm_data(
        &self,
        alarm_days: u64,
        soe_days: u64,
    ) -> anyhow::Result<(u64, u64)> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let alarm_cutoff = now_ms.saturating_sub(alarm_days.saturating_mul(86_400_000));
        let soe_cutoff = now_ms.saturating_sub(soe_days.saturating_mul(86_400_000));
        self.conn
            .call(move |conn| {
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
            })
            .await
            .map_err(db_err)
    }
}
