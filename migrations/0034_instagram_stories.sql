CREATE TABLE IF NOT EXISTS instagram_topics (
  chat_id TEXT NOT NULL,
  topic_key TEXT NOT NULL CHECK(topic_key IN ('greeting','album','plan','generator')),
  thread_id INTEGER NOT NULL,
  PRIMARY KEY(chat_id, topic_key)
);
CREATE TABLE IF NOT EXISTS instagram_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('FASHION_HELLO','FASHION','КАТАЛОГ','ТЕСТЫ','ЭМОЦИИ','БЬЮТИ')),
  telegram_file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  day_key TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chat_id, file_unique_id, day_key)
);
CREATE INDEX IF NOT EXISTS idx_instagram_photos_category_day ON instagram_photos(chat_id, day_key, category);
CREATE TABLE IF NOT EXISTS instagram_plans (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id, thread_id, day_key)
);

CREATE TABLE IF NOT EXISTS instagram_upload_context (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id, thread_id, uploader_id, day_key)
);
