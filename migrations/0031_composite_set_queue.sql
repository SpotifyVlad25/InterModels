-- Mark durable four-variant sets separately from ordinary multi-model batches.
ALTER TABLE secretary_operations ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'batch' CHECK(operation_type IN ('batch','set'));
