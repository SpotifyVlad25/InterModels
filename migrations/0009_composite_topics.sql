CREATE TABLE IF NOT EXISTS secretary_composite_topics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  configured_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
