CREATE TABLE IF NOT EXISTS secretary_photo_album_items (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  media_group_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  model_id TEXT,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, thread_id, uploader_id, media_group_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_secretary_photo_album_items_group
  ON secretary_photo_album_items (chat_id, thread_id, uploader_id, media_group_id);
