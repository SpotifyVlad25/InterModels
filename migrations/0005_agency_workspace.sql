-- Agency workspace foundation: director-managed photos and generated composite cards.
-- Photo binaries live in Cloudflare R2; D1 stores metadata and object keys only.

ALTER TABLE model_profiles ADD COLUMN hair_color TEXT;
ALTER TABLE model_profiles ADD COLUMN eye_color TEXT;

CREATE TABLE IF NOT EXISTS model_photos (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  is_profile_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_profile_primary IN (0, 1)),
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_id, position)
);

CREATE INDEX IF NOT EXISTS idx_model_photos_model_position
  ON model_photos(model_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_photos_one_profile_primary
  ON model_photos(model_id) WHERE is_profile_primary = 1;

CREATE TABLE IF NOT EXISTS composite_cards (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  image_object_key TEXT,
  pdf_object_key TEXT,
  source_fingerprint TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_id, version)
);

CREATE INDEX IF NOT EXISTS idx_composite_cards_latest
  ON composite_cards(model_id, version DESC);

CREATE TABLE IF NOT EXISTS agency_audit_log (
  id TEXT PRIMARY KEY,
  actor_telegram_id TEXT NOT NULL,
  action TEXT NOT NULL,
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agency_audit_model_created
  ON agency_audit_log(model_id, created_at DESC);
