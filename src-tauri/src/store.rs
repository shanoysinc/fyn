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
             -- Clipboard history. `data` is DPAPI-encrypted (see clipboard::crypto): the
             -- text, or for an image a small thumbnail (the image itself is an encrypted
             -- file). Nothing readable is stored. Password-like text never gets here.
             CREATE TABLE IF NOT EXISTS clipboard (
                 id      INTEGER PRIMARY KEY AUTOINCREMENT,
                 created INTEGER NOT NULL,
                 source  TEXT,
                 data    BLOB NOT NULL
             );
             -- Pomodoro focus sessions, for history and stats.
             CREATE TABLE IF NOT EXISTS pomodoro_sessions (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 started    INTEGER NOT NULL,
                 ended      INTEGER NOT NULL,
                 focus_secs INTEGER NOT NULL,
                 completed  INTEGER NOT NULL,
                 label      TEXT
             );",
        )?;
        // Image support (added later): add the columns to databases created before it.
        let has_kind = conn
            .prepare("SELECT 1 FROM pragma_table_info('clipboard') WHERE name = 'kind'")?
            .exists([])?;
        if !has_kind {
            conn.execute_batch(
                "ALTER TABLE clipboard ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
                 ALTER TABLE clipboard ADD COLUMN width INTEGER;
                 ALTER TABLE clipboard ADD COLUMN height INTEGER;
                 ALTER TABLE clipboard ADD COLUMN bytes INTEGER;
                 ALTER TABLE clipboard ADD COLUMN hash INTEGER;",
            )?;
        }
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

    /// Insert a row (its `id` is ignored); returns the new id.
    pub fn clip_insert(&self, row: &ClipRow) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO clipboard (created, source, data, kind, width, height, bytes, hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                row.created,
                row.source,
                row.data,
                if row.image.is_some() { "image" } else { "text" },
                row.image.map(|i| i.width),
                row.image.map(|i| i.height),
                row.image.map(|i| i.bytes as i64),
                row.image.map(|i| i.hash as i64),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// All items, newest first.
    pub fn clip_all(&self) -> Vec<ClipRow> {
        let Ok(mut stmt) = self.conn.prepare_cached(
            "SELECT id, created, source, data, kind, width, height, bytes, hash
             FROM clipboard ORDER BY created DESC, id DESC",
        ) else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            let image = (r.get::<_, String>(4)? == "image").then(|| -> rusqlite::Result<ImageMeta> {
                Ok(ImageMeta {
                    width: r.get(5)?,
                    height: r.get(6)?,
                    bytes: r.get::<_, i64>(7)? as u64,
                    hash: r.get::<_, i64>(8)? as u64,
                })
            });
            Ok(ClipRow {
                id: r.get(0)?,
                created: r.get(1)?,
                source: r.get(2)?,
                data: r.get(3)?,
                image: image.transpose()?,
            })
        })
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

    /// Delete items older than `cutoff`, beyond the newest `keep`, or images beyond the
    /// newest `keep_images`. Returns the ids removed (so image files can be deleted too).
    pub fn clip_prune(&self, cutoff: i64, keep: usize, keep_images: usize) -> rusqlite::Result<Vec<i64>> {
        let ids: Vec<i64> = {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM clipboard WHERE created < ?1
                 OR id NOT IN (SELECT id FROM clipboard ORDER BY created DESC, id DESC LIMIT ?2)
                 OR (kind = 'image' AND id NOT IN
                     (SELECT id FROM clipboard WHERE kind = 'image' ORDER BY created DESC, id DESC LIMIT ?3))",
            )?;
            let rows = stmt.query_map(params![cutoff, keep as i64, keep_images as i64], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for id in &ids {
            self.conn.execute("DELETE FROM clipboard WHERE id = ?1", [id])?;
        }
        Ok(ids)
    }

    // ---------- pomodoro ----------

    pub fn pomo_insert(&self, s: &crate::miniapps::pomodoro::Session) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO pomodoro_sessions (started, ended, focus_secs, completed, label) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![s.started, s.ended, s.focus_secs, s.completed, s.label],
        )?;
        Ok(())
    }

    pub fn pomo_all(&self) -> Vec<crate::miniapps::pomodoro::Session> {
        let Ok(mut stmt) = self
            .conn
            .prepare_cached("SELECT started, ended, focus_secs, completed, label FROM pomodoro_sessions ORDER BY started")
        else {
            return Vec::new();
        };
        stmt.query_map([], |r| {
            Ok(crate::miniapps::pomodoro::Session {
                started: r.get(0)?,
                ended: r.get(1)?,
                focus_secs: r.get(2)?,
                completed: r.get(3)?,
                label: r.get(4)?,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    }

    pub fn pomo_clear(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM pomodoro_sessions", [])?;
        Ok(())
    }
}

/// Size and fingerprint of a clipboard image.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    /// Size of the encoded PNG.
    pub bytes: u64,
    /// Fingerprint of the PNG, to spot the same image copied again.
    pub hash: u64,
}

/// A stored clipboard item: encrypted `data` (text, or an image's thumbnail).
#[derive(Clone, Debug, PartialEq)]
pub struct ClipRow {
    pub id: i64,
    pub created: i64,
    pub source: Option<String>,
    pub data: Vec<u8>,
    pub image: Option<ImageMeta>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).expect("in-memory db")
    }

    fn text_row(created: i64, source: Option<&str>, data: &[u8]) -> ClipRow {
        ClipRow { id: 0, created, source: source.map(str::to_string), data: data.to_vec(), image: None }
    }

    fn image_row(created: i64) -> ClipRow {
        ClipRow {
            image: Some(ImageMeta { width: 1920, height: 1080, bytes: 123_456, hash: u64::MAX - 7 }),
            ..text_row(created, Some("snippingtool.exe"), b"thumb")
        }
    }

    #[test]
    fn clipboard_rows_insert_list_delete() {
        let s = store();
        let a = s.clip_insert(&text_row(100, Some("code.exe"), b"enc-a")).unwrap();
        let b = s.clip_insert(&text_row(200, None, b"enc-b")).unwrap();
        let all = s.clip_all();
        assert_eq!(all.iter().map(|r| r.id).collect::<Vec<_>>(), vec![b, a]); // newest first
        assert_eq!(all[1].source.as_deref(), Some("code.exe"));
        assert_eq!(all[0].data, b"enc-b");
        assert_eq!(all[0].image, None);
        s.clip_delete(a).unwrap();
        assert_eq!(s.clip_all().len(), 1);
        s.clip_delete_all().unwrap();
        assert!(s.clip_all().is_empty());
    }

    #[test]
    fn clipboard_images_keep_their_size_and_fingerprint() {
        let s = store();
        let id = s.clip_insert(&image_row(100)).unwrap();
        let row = &s.clip_all()[0];
        assert_eq!(row.id, id);
        assert_eq!(row.image, image_row(100).image); // incl. a hash above i64::MAX
    }

    #[test]
    fn clipboard_prune_by_age_count_and_image_count() {
        let s = store();
        for t in 1..=10 {
            s.clip_insert(&text_row(t * 100, None, b"x")).unwrap();
        }
        // Older than 300 goes (100, 200), then only the newest 5 stay.
        assert_eq!(s.clip_prune(300, 5, 50).unwrap().len(), 5);
        let created: Vec<i64> = s.clip_all().iter().map(|r| r.created).collect();
        assert_eq!(created, vec![1000, 900, 800, 700, 600]);

        // Images have their own, smaller cap.
        let first = s.clip_insert(&image_row(1100)).unwrap();
        s.clip_insert(&image_row(1200)).unwrap();
        assert_eq!(s.clip_prune(0, 200, 1).unwrap(), vec![first]);
        assert_eq!(s.clip_all().iter().filter(|r| r.image.is_some()).count(), 1);
    }

    #[test]
    fn old_databases_gain_the_image_columns() {
        let dir = std::env::temp_dir().join(format!("fyn-store-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.db");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE clipboard (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL,
                                         source TEXT, data BLOB NOT NULL);
                 INSERT INTO clipboard (created, source, data) VALUES (5, NULL, x'01');",
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        let rows = s.clip_all();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].image, None); // existing rows become text
        drop(s);
        Store::open(&path).unwrap(); // and opening again doesn't try to migrate twice
        let _ = std::fs::remove_dir_all(&dir);
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
