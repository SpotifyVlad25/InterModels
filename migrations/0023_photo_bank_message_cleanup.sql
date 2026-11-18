-- Track each MODEL BANK upload session so the topic can be reduced to one
-- final confirmation card after the seven originals have been saved.
CREATE TABLE secretary_photo_upload_sessions (
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  command_message_id INTEGER,
  prompt_message_id INTEGER,
  progress_message_id INTEGER,
  photo_message_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, thread_id, uploader_id)
);
