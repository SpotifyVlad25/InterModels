-- Persist actionable diagnostics for single composite generation failures.
ALTER TABLE secretary_operations ADD COLUMN failure_stage TEXT;
ALTER TABLE secretary_operations ADD COLUMN failure_message TEXT;
ALTER TABLE secretary_operations ADD COLUMN failure_stack TEXT;
ALTER TABLE secretary_operations ADD COLUMN failed_at TEXT;
