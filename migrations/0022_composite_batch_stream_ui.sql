-- Track temporary UI messages for composite batch streams and their cleanup.
ALTER TABLE secretary_operations ADD COLUMN intro_message_id INTEGER;
ALTER TABLE secretary_operations ADD COLUMN queue_message_id INTEGER;
ALTER TABLE secretary_operations ADD COLUMN input_message_id INTEGER;
ALTER TABLE secretary_operations ADD COLUMN cleanup_at TEXT;

-- Keep the initiating /comp message so both it and the submitted name list can be removed.
ALTER TABLE secretary_composite_input_pending ADD COLUMN command_message_id INTEGER;
