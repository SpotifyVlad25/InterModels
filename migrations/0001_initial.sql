PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  telegram_user_id TEXT UNIQUE,
  linked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_models_phone ON models(phone);
CREATE INDEX IF NOT EXISTS idx_models_name ON models(last_name, first_name);

CREATE TABLE IF NOT EXISTS registration_requests (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  search_method TEXT NOT NULL CHECK (search_method IN ('name', 'phone')),
  submitted_value TEXT NOT NULL,
  candidate_model_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'conflict')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_registration_user
  ON registration_requests(telegram_user_id, status);

CREATE TABLE IF NOT EXISTS model_profiles (
  model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  height_cm REAL,
  weight_kg REAL,
  bust_cm REAL,
  waist_cm REAL,
  hips_cm REAL,
  clothing_size TEXT,
  shoe_size TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  telegram_user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
