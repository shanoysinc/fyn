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
             );
             -- Clipboard history. `data` is DPAPI-encrypted text (see clipboard::crypto);
             -- nothing readable is stored. Password-like items never get here.
             CREATE TABLE IF NOT EXISTS clipboard (
                 id      INTEGER PRIMARY KEY AUTOINCREMENT,
                 created INTEGER NOT NULL,
                 source  TEXT,
                 data    BLOB NOT NULL
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

    // ---------- clipboard history (encrypted blobs only) ----------

    pub fn clip_insert(&self, created: i64, source: Option<&str>, data: &[u8]) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO clipboard (created, source, data) VALUES (?1, ?2, ?3)",
            params![created, source, data],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// All items, newest first: (id, created, source, encrypted data).
    pub fn clip_all(&self) -> Vec<(i64, i64, Option<String>, Vec<u8>)> {
        let Ok(mut stmt) = self
            .conn
            .prepare_cached("SELECT id, created, source, data FROM clipboard ORDER BY created DESC, id DESC")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn clip_delete(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM clipboard WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Delete everything, and compact the file so the deleted blobs don't linger on disk.
    pub fn clip_delete_all(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM clipboard", [])?;
        self.conn.execute_batch("VACUUM")?;
        Ok(())
    }

    /// Drop items older than `cutoff` and anything beyond the newest `keep`.
    /// Returns how many were removed.
    pub fn clip_prune(&self, cutoff: i64, keep: usize) -> rusqlite::Result<usize> {
        let old = self.conn.execute("DELETE FROM clipboard WHERE created < ?1", [cutoff])?;
        let extra = self.conn.execute(
            "DELETE FROM clipboard WHERE id NOT IN
               (SELECT id FROM clipboard ORDER BY created DESC, id DESC LIMIT ?1)",
            [keep as i64],
        )?;
        Ok(old + extra)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).expect("in-memory db")
    }

    #[test]
    fn clipboard_rows_insert_list_delete() {
        let s = store();
        let a = s.clip_insert(100, Some("code.exe"), b"enc-a").unwrap();
        let b = s.clip_insert(200, None, b"enc-b").unwrap();
        let all = s.clip_all();
        assert_eq!(all.iter().map(|r| r.0).collect::<Vec<_>>(), vec![b, a]); // newest first
        assert_eq!(all[1].2.as_deref(), Some("code.exe"));
        assert_eq!(all[0].3, b"enc-b");
        s.clip_delete(a).unwrap();
        assert_eq!(s.clip_all().len(), 1);
        s.clip_delete_all().unwrap();
        assert!(s.clip_all().is_empty());
    }

    #[test]
    fn clipboard_prune_by_age_and_count() {
        let s = store();
        for t in 1..=10 {
            s.clip_insert(t * 100, None, b"x").unwrap();
        }
        // Older than 300 goes (100, 200), then only the newest 5 stay.
        assert_eq!(s.clip_prune(300, 5).unwrap(), 5);
        let created: Vec<i64> = s.clip_all().iter().map(|r| r.1).collect();
        assert_eq!(created, vec![1000, 900, 800, 700, 600]);
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
