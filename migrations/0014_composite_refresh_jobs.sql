CREATE TABLE IF NOT EXISTS composite_refresh_jobs (
  campaign_id TEXT NOT NULL REFERENCES profile_refresh_campaigns(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_composite_refresh_jobs_status
  ON composite_refresh_jobs(status, created_at);
