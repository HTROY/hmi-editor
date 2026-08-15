//! Repository layer - thread-safe CRUD for plugins, points and users.
//!
//! Backed by a [`tokio_rusqlite::Connection`]: SQLite runs on a dedicated
//! background thread, so awaiting any method never blocks a tokio worker
//! (async handlers, WebSocket heartbeats and redundancy probes stay live).
//!
//! Implementation is split per resource domain (see [`self::plugins`],
//! [`self::points`], [`self::projects`], [`self::users`], [`self::alarms`],
//! [`self::config`], [`self::snapshot`]); row structs live in [`self::rows`]
//! and are re-exported here for crate consumers.

mod alarms;
mod config;
mod plugins;
mod points;
mod projects;
mod rows;
mod snapshot;
mod users;

pub use rows::*;

use tokio_rusqlite::Connection;

/// Convert a tokio-rusqlite channel error into an anyhow error.
fn db_err(e: tokio_rusqlite::Error) -> anyhow::Error {
    anyhow::anyhow!("database error: {}", e)
}

pub struct Repo {
    conn: Connection,
}

impl Repo {
    /// Open (or create) the SQLite database. The connection runs on a
    /// dedicated tokio-rusqlite thread.
    pub async fn new(path: &str) -> anyhow::Result<Self> {
        let conn = Connection::open(path).await?;
        conn.call(|c| -> anyhow::Result<()> {
            c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
            super::schema::init_db(c)?;
            Ok(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("database error: {}", e))?;
        Ok(Self { conn })
    }
}

#[cfg(test)]
mod tests;
