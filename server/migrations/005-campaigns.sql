CREATE TABLE IF NOT EXISTS available_member_numbers (
 number INTEGER PRIMARY KEY,
 released_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('sms','whatsapp')),
 body TEXT NOT NULL,
 template_sid TEXT NOT NULL DEFAULT '',
 audience_branch TEXT NOT NULL DEFAULT 'all' CHECK(audience_branch IN ('all','san_salvador','san_miguel')),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','running','completed','cancelled')),
 scheduled_at TEXT,
 recipient_count INTEGER NOT NULL DEFAULT 0,
 sent_count INTEGER NOT NULL DEFAULT 0,
 failed_count INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER REFERENCES admins(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
 id INTEGER PRIMARY KEY,
 campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
 member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
 phone TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
 provider_id TEXT NOT NULL DEFAULT '',
 error TEXT NOT NULL DEFAULT '',
 sent_at TEXT,
 UNIQUE(campaign_id,member_id)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status_schedule ON campaigns(status,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status ON campaign_recipients(campaign_id,status);
PRAGMA user_version=5;
