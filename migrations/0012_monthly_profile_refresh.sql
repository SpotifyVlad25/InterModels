-- Monthly profile refresh campaigns and reversible model freezing.
ALTER TABLE models ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'frozen'));

CREATE TABLE IF NOT EXISTS director_refresh_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cycle_day INTEGER NOT NULL DEFAULT 1 CHECK (cycle_day BETWEEN 1 AND 28),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  campaign_start_time TEXT NOT NULL DEFAULT '09:00',
  reminder_times_json TEXT NOT NULL DEFAULT '["09:00","20:00","09:00","20:00"]',
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO director_refresh_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS profile_refresh_campaigns (
  id TEXT PRIMARY KEY,
  cycle_key TEXT NOT NULL UNIQUE,
  starts_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS profile_refresh_members (
  campaign_id TEXT NOT NULL REFERENCES profile_refresh_campaigns(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','updated','frozen')),
  updated_at TEXT,
  frozen_at TEXT,
  PRIMARY KEY (campaign_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_refresh_members_status
  ON profile_refresh_members(campaign_id, status);

CREATE TABLE IF NOT EXISTS profile_refresh_reminders (
  campaign_id TEXT NOT NULL REFERENCES profile_refresh_campaigns(id) ON DELETE CASCADE,
  reminder_index INTEGER NOT NULL CHECK (reminder_index BETWEEN 1 AND 4),
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (campaign_id, reminder_index)
);

CREATE TABLE IF NOT EXISTS composite_topic_publications (
  model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  campaign_id TEXT,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
