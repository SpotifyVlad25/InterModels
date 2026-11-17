CREATE TABLE IF NOT EXISTS secretary_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('photo_upload','composite','composite_batch')),
  actor_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','cancelled','completed','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_secretary_operations_status
  ON secretary_operations(status, updated_at);