-- Track the current Telegram album published for each model/style so replacement can remove the previous package.
CREATE TABLE secretary_photo_database_publications (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  style TEXT NOT NULL CHECK(style IN ('basic','fashion')),
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  message_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(model_id, style)
);
