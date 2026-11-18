-- Expand each model's Telegram photo bank from four to seven images.
-- Rebuild both tables because SQLite cannot alter an existing CHECK constraint.

CREATE TABLE model_telegram_photos_new (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 7),
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_thread_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (model_id, position)
);

INSERT INTO model_telegram_photos_new (
  model_id, position, telegram_file_id, telegram_file_unique_id,
  uploaded_by, source_chat_id, source_thread_id, created_at, updated_at
)
SELECT
  model_id, position, telegram_file_id, telegram_file_unique_id,
  uploaded_by, source_chat_id, source_thread_id, created_at, updated_at
FROM model_telegram_photos;

DROP TABLE model_telegram_photos;
ALTER TABLE model_telegram_photos_new RENAME TO model_telegram_photos;

CREATE INDEX IF NOT EXISTS idx_model_telegram_photos_model_position
  ON model_telegram_photos(model_id, position);

CREATE TABLE secretary_photo_batches_new (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  next_position INTEGER NOT NULL CHECK (next_position BETWEEN 2 AND 8),
  photos_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, thread_id, uploader_id)
);

INSERT INTO secretary_photo_batches_new (
  chat_id, thread_id, uploader_id, model_id, next_position, photos_json, updated_at
)
SELECT chat_id, thread_id, uploader_id, model_id, next_position, photos_json, updated_at
FROM secretary_photo_batches;

DROP TABLE secretary_photo_batches;
ALTER TABLE secretary_photo_batches_new RENAME TO secretary_photo_batches;
