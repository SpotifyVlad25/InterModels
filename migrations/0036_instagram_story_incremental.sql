ALTER TABLE instagram_story_jobs ADD COLUMN next_story_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE instagram_story_jobs ADD COLUMN style INTEGER;
ALTER TABLE instagram_story_jobs ADD COLUMN used_photo_ids_json TEXT NOT NULL DEFAULT '[]';
