CREATE TABLE IF NOT EXISTS secretary_composite_batch_items (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES secretary_operations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  requested_name TEXT NOT NULL,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','published','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(operation_id, position)
);
CREATE INDEX IF NOT EXISTS idx_secretary_composite_batch_items_status
  ON secretary_composite_batch_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_secretary_composite_batch_items_operation
  ON secretary_composite_batch_items(operation_id, status);
