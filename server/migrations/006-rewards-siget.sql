CREATE TABLE IF NOT EXISTS rewards (
 id INTEGER PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 purchase_amount REAL NOT NULL CHECK(purchase_amount >= 0),
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 image TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rewards_schedule ON rewards(active,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS siget_submissions (
 id INTEGER PRIMARY KEY,
 member_id INTEGER NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
 file_name TEXT NOT NULL,
 file_type TEXT NOT NULL CHECK(file_type IN ('image/jpeg','application/pdf')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 review_note TEXT NOT NULL DEFAULT '',
 submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 reviewed_at TEXT,
 reviewed_by INTEGER REFERENCES admins(id),
 keychain_delivered INTEGER NOT NULL DEFAULT 0,
 keychain_delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_siget_status ON siget_submissions(status,submitted_at);

PRAGMA user_version=6;
