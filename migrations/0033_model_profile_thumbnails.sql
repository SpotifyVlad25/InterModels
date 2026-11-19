CREATE TABLE IF NOT EXISTS model_profile_thumbnails (
  model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  telegram_file_id TEXT NOT NULL,
  source_file_unique_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
