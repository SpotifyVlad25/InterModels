ALTER TABLE secretary_operations RENAME TO secretary_operations_old;
DROP INDEX IF EXISTS idx_secretary_operations_status;
CREATE TABLE secretary_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('photo_upload','composite','composite_batch')),
  actor_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  source_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','publishing','cancelled','completed','failed')),
  status_message_id INTEGER,
  result_chat_id TEXT,
  result_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO secretary_operations (id,kind,actor_id,chat_id,thread_id,source_key,status,created_at,updated_at)
SELECT id,kind,actor_id,chat_id,thread_id,source_key,status,created_at,updated_at
FROM secretary_operations_old;
DROP TABLE secretary_operations_old;
CREATE INDEX IF NOT EXISTS idx_secretary_operations_status
  ON secretary_operations(status, updated_at);
