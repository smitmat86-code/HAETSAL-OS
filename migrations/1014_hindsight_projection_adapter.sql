ALTER TABLE canonical_projection_results
  ADD COLUMN engine_bank_id TEXT;

ALTER TABLE canonical_projection_results
  ADD COLUMN engine_document_id TEXT;

ALTER TABLE canonical_projection_results
  ADD COLUMN engine_operation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_canonical_projection_results_operation
  ON canonical_projection_results(engine_operation_id, updated_at DESC);
