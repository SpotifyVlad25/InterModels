CREATE TABLE IF NOT EXISTS bot_topics (
  bot_key TEXT PRIMARY KEY CHECK (bot_key IN ('model', 'director')),
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL
);
