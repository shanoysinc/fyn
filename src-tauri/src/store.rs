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

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).expect("in-memory db")
    }

    #[test]
    fn toggle_pin_adds_then_removes() {
        let s = store();
        assert!(s.toggle_pin("a").unwrap());
        assert_eq!(s.pins(), ["a"]);
        assert!(!s.toggle_pin("a").unwrap());
        assert!(s.pins().is_empty());
    }

    #[test]
    fn pins_keep_insertion_order() {
        let s = store();
        for id in ["a", "b", "c"] {
            s.toggle_pin(id).unwrap();
        }
        assert_eq!(s.pins(), ["a", "b", "c"]);
        // Re-pinning after removal appends to the end.
        s.toggle_pin("a").unwrap();
        s.toggle_pin("a").unwrap();
        assert_eq!(s.pins(), ["b", "c", "a"]);
    }

    #[test]
    fn move_pin_reorders_and_clamps() {
        let mut s = store();
        for id in ["a", "b", "c"] {
            s.toggle_pin(id).unwrap();
        }
        s.move_pin("c", -1).unwrap();
        assert_eq!(s.pins(), ["a", "c", "b"]);
        s.move_pin("a", -1).unwrap(); // already first
        assert_eq!(s.pins(), ["a", "c", "b"]);
        s.move_pin("b", 1).unwrap(); // already last
        assert_eq!(s.pins(), ["a", "c", "b"]);
        s.move_pin("a", 5).unwrap(); // clamped to the end
        assert_eq!(s.pins(), ["c", "b", "a"]);
        s.move_pin("missing", 1).unwrap(); // unknown id is a no-op
        assert_eq!(s.pins(), ["c", "b", "a"]);
    }

    #[test]
    fn move_pin_on_empty_list_is_a_no_op() {
        let mut s = store();
        s.move_pin("a", 1).unwrap();
        assert!(s.pins().is_empty());
    }

    #[test]
    fn record_launch_counts_and_timestamps() {
        let s = store();
        let before = now();
        s.record_launch("a").unwrap();
        s.record_launch("a").unwrap();
        s.record_launch("b").unwrap();
        let usage = s.usage();
        assert_eq!(usage["a"].count, 2);
        assert_eq!(usage["b"].count, 1);
        assert!(usage["a"].last_used >= before);
        assert!(!usage.contains_key("c"));
    }

    #[test]
    fn settings_round_trip_and_overwrite() {
        let s = store();
        assert_eq!(s.get_setting("hotkey"), None);
        s.set_setting("hotkey", "Ctrl+Space").unwrap();
        assert_eq!(s.get_setting("hotkey").as_deref(), Some("Ctrl+Space"));
        s.set_setting("hotkey", "Alt+Space").unwrap();
        assert_eq!(s.get_setting("hotkey").as_deref(), Some("Alt+Space"));
    }

    #[test]
    fn data_persists_across_reopen() {
        let dir = std::env::temp_dir().join(format!("fyn-store-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fyn.db");
        {
            let s = Store::open(&path).unwrap();
            s.toggle_pin("a").unwrap();
            s.set_setting("theme", "dark").unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.pins(), ["a"]);
        assert_eq!(s.get_setting("theme").as_deref(), Some("dark"));
        drop(s);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
