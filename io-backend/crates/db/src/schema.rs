//! Database schema and migrations

use rusqlite::Connection;

pub fn init_db(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "
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

        CREATE TABLE IF NOT EXISTS alarm_rules (
            id          TEXT PRIMARY KEY,
            variable_id TEXT NOT NULL,
            name        TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            severity    TEXT NOT NULL DEFAULT 'warning',
            group_name  TEXT NOT NULL DEFAULT '',
            condition   TEXT NOT NULL DEFAULT 'high',
            threshold   REAL NOT NULL DEFAULT 0,
            enabled     INTEGER NOT NULL DEFAULT 1,
            hysteresis  REAL NOT NULL DEFAULT 0,
            confirm_ms  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS alarm_occurrences (
            id               TEXT PRIMARY KEY,
            rule_id          TEXT NOT NULL,
            variable_id      TEXT NOT NULL,
            name             TEXT NOT NULL DEFAULT '',
            severity         TEXT NOT NULL DEFAULT 'warning',
            group_name       TEXT NOT NULL DEFAULT '',
            message          TEXT NOT NULL DEFAULT '',
            value            TEXT NOT NULL DEFAULT '0',
            threshold        REAL NOT NULL DEFAULT 0,
            status           TEXT NOT NULL DEFAULT 'active',
            triggered_at     INTEGER NOT NULL,
            recovered_at     INTEGER,
            recovered_reason TEXT NOT NULL DEFAULT '',
            acknowledged_at  INTEGER,
            acknowledged_by  TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS alarm_stream_events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            occurrence_id TEXT NOT NULL,
            event_type    TEXT NOT NULL,
            at_ms         INTEGER NOT NULL,
            by_user       TEXT NOT NULL DEFAULT '',
            value         TEXT NOT NULL DEFAULT '0',
            message       TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS soe_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            seq          INTEGER NOT NULL,
            variable_id  TEXT NOT NULL,
            value        TEXT NOT NULL DEFAULT '0',
            quality      TEXT NOT NULL DEFAULT 'good',
            device_time  INTEGER NOT NULL,
            receive_time INTEGER NOT NULL,
            source       TEXT NOT NULL DEFAULT 'backend'
        );

        CREATE INDEX IF NOT EXISTS idx_soe_seq ON soe_events(seq);
        CREATE INDEX IF NOT EXISTS idx_soe_time ON soe_events(receive_time);
        CREATE INDEX IF NOT EXISTS idx_occ_status_time ON alarm_occurrences(status, triggered_at);
        CREATE INDEX IF NOT EXISTS idx_occ_rule ON alarm_occurrences(rule_id);
        CREATE INDEX IF NOT EXISTS idx_stream_occ ON alarm_stream_events(occurrence_id);

        INSERT OR IGNORE INTO server_config (key, value) VALUES ('scan_interval_ms', '500');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('batch_interval_ms', '100');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('ws_host', '0.0.0.0');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('ws_port', '8080');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('web_port', '8081');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('plugin_dir', './plugins');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('alarm_retention_days', '90');
        INSERT OR IGNORE INTO server_config (key, value) VALUES ('soe_retention_days', '30');
    ",
    )?;

    // Migration: add description column if missing (backward compat)
    let has_col: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('points') WHERE name='description'")?
        .exists([])?;
    if !has_col {
        log::info!("Migrating: adding description column to points table");
        conn.execute_batch("ALTER TABLE points ADD COLUMN description TEXT NOT NULL DEFAULT ''")?;
    }

    // Migration: add instance-redundancy columns if missing
    for (col, sql) in [
        (
            "redundancy_group",
            "ALTER TABLE plugins ADD COLUMN redundancy_group TEXT NOT NULL DEFAULT ''",
        ),
        (
            "redundancy_role",
            "ALTER TABLE plugins ADD COLUMN redundancy_role TEXT NOT NULL DEFAULT ''",
        ),
        (
            "priority",
            "ALTER TABLE plugins ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        let has: bool = conn
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('plugins') WHERE name='{}'",
                col
            ))?
            .exists([])?;
        if !has {
            log::info!("Migrating: adding {} column to plugins table", col);
            conn.execute_batch(sql)?;
        }
    }

    Ok(())
}
