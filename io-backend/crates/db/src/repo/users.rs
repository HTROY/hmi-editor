//! User account CRUD.

use super::{db_err, Repo, UserRow};
use rusqlite::params;

fn map_user(row: &rusqlite::Row) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: row.get("id")?,
        username: row.get("username")?,
        password_hash: row.get("password_hash")?,
        role: row.get("role")?,
        must_change_password: row.get::<_, i32>("must_change_password")? != 0,
        token_version: row.get("token_version")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl Repo {
    pub async fn create_user(
        &self,
        username: &str,
        password_hash: &str,
        role: &str,
        must_change_password: bool,
    ) -> anyhow::Result<i64> {
        let username = username.to_owned();
        let password_hash = password_hash.to_owned();
        let role = role.to_owned();
        self.conn
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO users(username,password_hash,role,must_change_password)
                     VALUES(?1,?2,?3,?4)",
                    params![username, password_hash, role, must_change_password],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .await
            .map_err(db_err)
    }

    pub async fn get_user(&self, username: &str) -> anyhow::Result<Option<UserRow>> {
        let username = username.to_owned();
        self.conn
            .call(move |conn| {
                let mut sql = conn.prepare(
                    "SELECT id,username,password_hash,role,must_change_password,token_version,created_at,updated_at
                     FROM users WHERE username=?1",
                )?;
                let mut rows = sql.query_map(params![username], |r| map_user(r))?;
                match rows.next() {
                    Some(Ok(row)) => Ok(Some(row)),
                    Some(Err(e)) => Err(e),
                    None => Ok(None),
                }
            })
            .await
            .map_err(db_err)
    }

    pub async fn update_user_password(
        &self,
        username: &str,
        password_hash: &str,
        must_change_password: bool,
    ) -> anyhow::Result<u64> {
        let username = username.to_owned();
        let password_hash = password_hash.to_owned();
        self.conn
            .call(move |conn| {
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
            })
            .await
            .map_err(db_err)
    }

    pub async fn user_count(&self) -> anyhow::Result<i64> {
        self.conn
            .call(|conn| {
                let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
                Ok(count)
            })
            .await
            .map_err(db_err)
    }
}
