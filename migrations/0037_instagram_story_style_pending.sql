CREATE TABLE IF NOT EXISTS instagram_story_style_pending (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL,
  photo_file_id TEXT NOT NULL,
  story_text TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('position','fill','mode')),
  position TEXT,
  fill TEXT,
  prompt_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_instagram_story_style_pending_user
  ON instagram_story_style_pending(chat_id, thread_id, user_id, created_at);
