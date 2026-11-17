CREATE TABLE IF NOT EXISTS telegram_processed_updates (
  bot_key TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_key, update_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_processed_at
  ON telegram_processed_updates(processed_at);
