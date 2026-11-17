-- Active agency model profile for Vladislav Demakov.
INSERT INTO models (id, first_name, last_name, phone, is_active)
VALUES ('modelvladislav01', 'Владислав', 'Демаков', NULL, 1)
ON CONFLICT(id) DO NOTHING;
