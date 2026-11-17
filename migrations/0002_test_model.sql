-- Temporary fictional model used to verify InterModels registration flow.
INSERT INTO models (id, first_name, last_name, phone, is_active)
VALUES ('testanna001', 'Анна', 'Тестова', NULL, 1)
ON CONFLICT(id) DO NOTHING;
