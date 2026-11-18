-- Keep every composite card independently addressable by model, photo style, and language.
-- Existing single publication is preserved as its current style/language variant.
ALTER TABLE composite_topic_publications RENAME TO composite_topic_publications_old;
CREATE TABLE composite_topic_publications (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  campaign_id TEXT,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  photo_file_ids_json TEXT,
  model_snapshot_json TEXT,
  style TEXT NOT NULL DEFAULT 'basic' CHECK(style IN ('basic','fashion')),
  language TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru','en')),
  PRIMARY KEY(model_id,style,language)
);
INSERT INTO composite_topic_publications(model_id,chat_id,thread_id,message_id,campaign_id,published_at,photo_file_ids_json,model_snapshot_json,style,language)
SELECT model_id,chat_id,thread_id,message_id,campaign_id,published_at,photo_file_ids_json,model_snapshot_json,style,language
FROM composite_topic_publications_old;
DROP TABLE composite_topic_publications_old;

-- Refresh jobs also need one row per published variant, not merely one per model.
ALTER TABLE composite_refresh_jobs RENAME TO composite_refresh_jobs_old;
CREATE TABLE composite_refresh_jobs (
  campaign_id TEXT NOT NULL REFERENCES profile_refresh_campaigns(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  style TEXT NOT NULL DEFAULT 'basic' CHECK(style IN ('basic','fashion')),
  language TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru','en')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(campaign_id,model_id,style,language)
);
INSERT INTO composite_refresh_jobs(campaign_id,model_id,style,language,status,attempts,last_error,created_at,updated_at)
SELECT j.campaign_id,j.model_id,COALESCE(p.style,'basic'),COALESCE(p.language,'ru'),j.status,j.attempts,j.last_error,j.created_at,j.updated_at
FROM composite_refresh_jobs_old j
LEFT JOIN composite_topic_publications p ON p.model_id=j.model_id;
DROP TABLE composite_refresh_jobs_old;
CREATE INDEX IF NOT EXISTS idx_composite_refresh_jobs_status
  ON composite_refresh_jobs(status,created_at);
