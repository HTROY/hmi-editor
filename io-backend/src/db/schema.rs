//! Database schema and migrations

use rusqlite::Connection;

pub fn init_db(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS server_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plugins (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            wasm_file   TEXT NOT NULL,
            config_json TEXT NOT NULL DEFAULT '{}',
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS points (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            plugin_id   INTEGER NOT NULL,
            variable_id TEXT NOT NULL,
            address     TEXT NOT NULL,
            data_type   TEXT NOT NULL DEFAULT 'uint16',
            byte_order  TEXT NOT NULL DEFAULT 'big_endian',
            scale       REAL NOT NULL DEFAULT 1.0,
            offset_val  REAL NOT NULL DEFAULT 0.0,
            var_type    TEXT NOT NULL DEFAULT 'AI',
            description TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE,
            UNIQUE(plugin_id, variable_id)
        );

        INSERT OR IGNORE INTO server_config (key, value) VALUES ('scan_interval_ms', '500');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('batch_interval_ms', '100');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('ws_host', '0.0.0.0');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('ws_port', '8080');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('web_port', '8081');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('plugin_dir', './plugins');
    ")?;

    // Migration: add description column if missing (backward compat)
    let has_col: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('points') WHERE name='description'")?
        .exists([])?;
    if !has_col {
        log::info!("Migrating: adding description column to points table");
        conn.execute_batch("ALTER TABLE points ADD COLUMN description TEXT NOT NULL DEFAULT ''")?;
    }

    Ok(())
}