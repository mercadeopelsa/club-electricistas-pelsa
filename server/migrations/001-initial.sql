CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins (
 id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 password TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
 token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id), expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL, email TEXT NOT NULL, whatsapp TEXT NOT NULL,
 dui_hash TEXT NOT NULL UNIQUE, dui_encrypted BLOB NOT NULL,
 front_file TEXT NOT NULL, back_file TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')),
 number INTEGER UNIQUE, token TEXT UNIQUE,
 show_email INTEGER NOT NULL DEFAULT 0, show_whatsapp INTEGER NOT NULL DEFAULT 0,
 referred_by INTEGER REFERENCES members(id),
 review_note TEXT NOT NULL DEFAULT '',
 consent_at TEXT NOT NULL, consent_version TEXT NOT NULL DEFAULT '2026-10-mvp',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 approved_at TEXT,
 reviewed_by INTEGER REFERENCES admins(id),
 profile_views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_members_status_created ON members(status,created_at);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO counters (name,value) VALUES ('member',0);
CREATE TABLE IF NOT EXISTS benefits (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
 icon TEXT NOT NULL DEFAULT 'tag', position INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS promotions (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
 image TEXT, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 clicks INTEGER NOT NULL DEFAULT 0,
 deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
PRAGMA user_version=1;
