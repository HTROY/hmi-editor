//! Config snapshot application (redundancy peer sync).

use super::{db_err, ConfigSnapshot, Repo};
use rusqlite::params;

impl Repo {
    /// 用 Active 节点推送的配置快照整体替换本机插件/点位与关键 server_config。
    /// 在单个 DB 线程调用内事务执行，保证幂等。
    pub async fn apply_config_snapshot(&self, snap: &ConfigSnapshot) -> anyhow::Result<()> {
        let snap = snap.clone();
        self.conn
            .call(move |conn| {
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
            })
            .await
            .map_err(db_err)
    }
}
