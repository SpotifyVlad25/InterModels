-- Store one Telegram progress message for each requested model in a composite stream.
ALTER TABLE secretary_composite_batch_items ADD COLUMN status_message_id INTEGER;
