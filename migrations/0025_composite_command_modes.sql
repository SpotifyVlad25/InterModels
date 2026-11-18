-- Distinguish single-model generation from multi-model batch requests.
ALTER TABLE secretary_composite_request_pending ADD COLUMN mode TEXT NOT NULL DEFAULT 'single' CHECK(mode IN ('single','batch'));
