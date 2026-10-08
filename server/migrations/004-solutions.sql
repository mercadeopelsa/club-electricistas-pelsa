CREATE TABLE IF NOT EXISTS solutions (
 id INTEGER PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('service','product')),
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 icon TEXT NOT NULL DEFAULT 'package',
 position INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_solutions_active_position ON solutions(active,position,id);
PRAGMA user_version=4;
