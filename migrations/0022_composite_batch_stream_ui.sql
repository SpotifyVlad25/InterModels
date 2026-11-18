-- Track temporary UI messages for composite batch streams and their cleanup.
ALTER TABLE secretary_operations ADD COLUMN intro_message_id INTEGER;
ALTER TABLE secretary_operations ADD COLUMN queue_message_id INTEGER;
ALTER TABLE secretary_operations ADD COLUMN input_message_id INTEGER;
ALTER TABLE secretary_operations ADD COLUMN cleanup_at TEXT;

-- Keep the initiating /comp message so both it and the submitted name list can be removed.
ALTER TABLE secretary_composite_input_pending ADD COLUMN command_message_id INTEGER;

-- Keep the exact source snapshot used for each published card so the file button
-- can reproduce that card even if the model's photo bank or measurements change later.
ALTER TABLE composite_topic_publications ADD COLUMN photo_file_ids_json TEXT;
ALTER TABLE composite_topic_publications ADD COLUMN model_snapshot_json TEXT;
