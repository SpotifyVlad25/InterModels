CREATE TABLE IF NOT EXISTS instagram_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  story_text TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('FASHION_HELLO','FASHION','КАТАЛОГ','ТЕСТЫ','ЭМОЦИИ','БЬЮТИ','ANY')),
  source_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chat_id, thread_id, day_key, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_instagram_plan_items_session ON instagram_plan_items(chat_id, thread_id, day_key, id);
CREATE TABLE IF NOT EXISTS instagram_plan_sessions (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, thread_id, day_key)
);
CREATE TABLE IF NOT EXISTS instagram_story_jobs (
  job_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  plan_thread_id INTEGER NOT NULL,
  output_thread_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_instagram_story_jobs_queue ON instagram_story_jobs(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_story_jobs_one_active_chat
  ON instagram_story_jobs(chat_id) WHERE status IN ('pending','processing');
