-- Keep one rolling Telegram album per model in the dedicated Compositarium topic.
ALTER TABLE composite_topic_publications ADD COLUMN telegram_photo_file_id TEXT;

CREATE TABLE IF NOT EXISTS secretary_compositarium_topics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  configured_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS compositarium_publications (
  model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  message_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS secretary_composite_set_pending (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  prompt_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,thread_id,user_id)
);
