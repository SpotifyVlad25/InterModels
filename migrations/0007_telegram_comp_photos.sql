CREATE TABLE IF NOT EXISTS secretary_photo_topics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  configured_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS secretary_photo_batches (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  next_position INTEGER NOT NULL CHECK (next_position BETWEEN 2 AND 5),
  photos_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, thread_id, uploader_id)
);

CREATE TABLE IF NOT EXISTS model_telegram_photos (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_thread_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (model_id, position)
);

CREATE INDEX IF NOT EXISTS idx_model_telegram_photos_model_position
  ON model_telegram_photos(model_id, position);