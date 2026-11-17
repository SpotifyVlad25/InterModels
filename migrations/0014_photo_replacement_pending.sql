CREATE TABLE IF NOT EXISTS secretary_photo_replacement_pending (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  photos_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, thread_id, user_id)
);
