-- Keep an optional progress-message id for MODEL BANK upload cleanup.
ALTER TABLE secretary_photo_upload_sessions ADD COLUMN progress_message_id INTEGER;
