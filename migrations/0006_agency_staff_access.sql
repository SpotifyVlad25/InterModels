-- Staff permissions managed by the Director Mini App.
-- Owner and Director remain bootstrap administrators via Worker environment variables.
CREATE TABLE IF NOT EXISTS agency_staff_access (
  telegram_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'helper' CHECK (role IN ('helper', 'viewer')),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agency_staff_active
  ON agency_staff_access(is_active, role);
