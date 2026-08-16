-- Lease-bound artifact finalization and destructive expiry ownership.
-- All fields remain content-free operational metadata.

ALTER TABLE artifact_intake_finalizations ADD COLUMN expected_operation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_intake_finalizations ADD COLUMN artifact_manifest_sha256 TEXT;
ALTER TABLE artifact_intake_finalizations ADD COLUMN lease_owner TEXT;
ALTER TABLE artifact_intake_finalizations ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE artifact_intake_finalizations ADD COLUMN recovery_expires_at INTEGER;

ALTER TABLE artifact_intake_operations ADD COLUMN finalization_id TEXT;
ALTER TABLE artifact_intake_operations ADD COLUMN finalization_protected_until INTEGER;
ALTER TABLE artifact_intake_operations ADD COLUMN ciphertext_byte_length INTEGER;
ALTER TABLE artifact_intake_operations ADD COLUMN expiry_claim_token TEXT;
ALTER TABLE artifact_intake_operations ADD COLUMN expiry_claim_expires_at INTEGER;

-- AES-GCM managed envelopes have a fixed 33-byte overhead: five-byte family
-- prefix, twelve-byte IV, and sixteen-byte authentication tag. Backfill this
-- recorded identity before the new proof path can service idempotent replays.
UPDATE artifact_intake_operations
SET ciphertext_byte_length = byte_length + 33
WHERE status IN ('sealed', 'finalized')
  AND encryption_family IN ('tmk', 'kek')
  AND ciphertext_sha256 IS NOT NULL
  AND ciphertext_byte_length IS NULL;

-- Bind every pre-migration operation which had crossed the old canonical
-- pointer boundary, including already-finalized rows. Reserved finalizations
-- get one finite recovery window; finalized rows remain replayable.
UPDATE artifact_intake_finalizations
SET recovery_expires_at = updated_at + 1800000
WHERE status = 'reserved' AND recovery_expires_at IS NULL;

UPDATE artifact_intake_operations
SET finalization_id = (
      SELECT f.id FROM artifact_intake_finalizations f
      WHERE f.tenant_id = artifact_intake_operations.tenant_id
        AND f.canonical_capture_id = artifact_intake_operations.canonical_capture_id
        AND f.canonical_document_id = artifact_intake_operations.canonical_document_id
        AND f.canonical_operation_id = artifact_intake_operations.canonical_operation_id
        AND f.status IN ('reserved', 'finalized') LIMIT 1
    ),
    finalization_protected_until = (
      SELECT f.recovery_expires_at FROM artifact_intake_finalizations f
      WHERE f.tenant_id = artifact_intake_operations.tenant_id
        AND f.canonical_capture_id = artifact_intake_operations.canonical_capture_id
        AND f.status IN ('reserved', 'finalized') LIMIT 1
    ),
    expires_at = MAX(expires_at, COALESCE((
      SELECT f.recovery_expires_at FROM artifact_intake_finalizations f
      WHERE f.tenant_id = artifact_intake_operations.tenant_id
        AND f.canonical_capture_id = artifact_intake_operations.canonical_capture_id
        AND f.status IN ('reserved', 'finalized') LIMIT 1
    ), expires_at))
WHERE status IN ('sealed', 'finalized') AND canonical_capture_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM artifact_intake_finalizations f
    WHERE f.tenant_id = artifact_intake_operations.tenant_id
      AND f.canonical_capture_id = artifact_intake_operations.canonical_capture_id
      AND f.canonical_document_id = artifact_intake_operations.canonical_document_id
      AND f.canonical_operation_id = artifact_intake_operations.canonical_operation_id
      AND f.status IN ('reserved', 'finalized')
  );

UPDATE artifact_intake_finalizations
SET expected_operation_count = (
  SELECT COUNT(*) FROM artifact_intake_operations o
  WHERE o.tenant_id = artifact_intake_finalizations.tenant_id
    AND o.finalization_id = artifact_intake_finalizations.id
)
WHERE status IN ('reserved', 'finalized');

CREATE INDEX IF NOT EXISTS idx_artifact_finalizations_recovery
  ON artifact_intake_finalizations(status, recovery_expires_at);

CREATE INDEX IF NOT EXISTS idx_artifact_operations_finalization
  ON artifact_intake_operations(tenant_id, finalization_id, status);

CREATE INDEX IF NOT EXISTS idx_artifact_operations_expiry_claim
  ON artifact_intake_operations(status, expires_at, expiry_claim_expires_at);
