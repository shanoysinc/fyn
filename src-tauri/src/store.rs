//! Persistent user data (pins, usage, settings) in SQLite.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

pub struct Usage {
    pub count: u32,
    pub last_used: i64,
}

pub struct Store {
    conn: Connection,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS pins (
                 app_id   TEXT PRIMARY KEY,
                 position INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS usage (
                 app_id    TEXT PRIMARY KEY,
                 count     INTEGER NOT NULL,
                 last_used INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )?;
        Ok(Self { conn })
    }

    pub fn pins(&self) -> Vec<String> {
        let Ok(mut stmt) = self.conn.prepare_cached("SELECT app_id FROM pins ORDER BY position")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Returns `true` if the app is now pinned.
    pub fn toggle_pin(&self, id: &str) -> rusqlite::Result<bool> {
        let removed = self.conn.execute("DELETE FROM pins WHERE app_id = ?1", [id])?;
        if removed > 0 {
            return Ok(false);
        }
        self.conn.execute(
            "INSERT INTO pins (app_id, position)
             VALUES (?1, COALESCE((SELECT MAX(position) FROM pins), -1) + 1)",
            [id],
        )?;
        Ok(true)
    }

    /// Move a pin up (`delta < 0`) or down (`delta > 0`).
    pub fn move_pin(&mut self, id: &str, delta: i32) -> rusqlite::Result<()> {
        let mut pins = self.pins();
        let Some(from) = pins.iter().position(|p| p == id) else { return Ok(()) };
        let to = (from as i32 + delta).clamp(0, pins.len() as i32 - 1) as usize;
        if from == to {
            return Ok(());
        }
        let item = pins.remove(from);
        pins.insert(to, item);

        let tx = self.conn.transaction()?;
        for (pos, pin) in pins.iter().enumerate() {
            tx.execute("UPDATE pins SET position = ?1 WHERE app_id = ?2", params![pos as i64, pin])?;
        }
        tx.commit()
    }

    pub fn record_launch(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO usage (app_id, count, last_used) VALUES (?1, 1, ?2)
             ON CONFLICT(app_id) DO UPDATE SET count = count + 1, last_used = ?2",
            params![id, now()],
        )?;
        Ok(())
    }

    pub fn usage(&self) -> HashMap<String, Usage> {
        let Ok(mut stmt) = self.conn.prepare_cached("SELECT app_id, count, last_used FROM usage")
        else {
            return HashMap::new();
        };
        stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, Usage { count: r.get(1)?, last_used: r.get(2)? }))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            [key, value],
        )?;
        Ok(())
    }
}
