CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 location TEXT NOT NULL,
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 registration_url TEXT NOT NULL DEFAULT '',
 image TEXT,
 video_url TEXT NOT NULL DEFAULT '',
 video_embed TEXT NOT NULL DEFAULT '',
 video_provider TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_schedule ON events(active,starts_at,ends_at);
PRAGMA user_version=2;
