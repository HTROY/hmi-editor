//! Runtime configuration key/value pairs (`server_config` table).

use super::{db_err, Repo};
use rusqlite::{params, OptionalExtension};

impl Repo {
    pub async fn get_config(&self, key: &str) -> Option<String> {
        let key = key.to_owned();
        self.conn
            .call(move |conn| {
                conn.query_row(
                    "SELECT value FROM server_config WHERE key=?1",
                    params![key],
                    |r| r.get(0),
                )
                .optional()
            })
            .await
            .ok()
            .flatten()
    }
    pub async fn set_config(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let key = key.to_owned();
        let value = value.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO server_config(key,value) VALUES(?1,?2)",
                    params![key, value],
                )
            })
            .await
            .map_err(db_err)?;
        Ok(())
    }
}
