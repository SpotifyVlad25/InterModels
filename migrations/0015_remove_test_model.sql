-- Remove the temporary fictional test model. The model's dependent D1 records
-- are removed through the existing ON DELETE CASCADE foreign keys.
DELETE FROM models WHERE id = 'testanna001' AND first_name = 'Анна' AND last_name = 'Тестова';
