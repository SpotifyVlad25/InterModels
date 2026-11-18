-- External Telegram photo database topics and plain-text MODEL BANK upload intents.
CREATE TABLE secretary_photo_database_topics (
  style TEXT PRIMARY KEY CHECK(style IN ('basic','fashion')),
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  configured_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chat_id, thread_id)
);

CREATE TABLE secretary_photo_upload_intents (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  style TEXT CHECK(style IN ('basic','fashion')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id, thread_id, uploader_id)
);
