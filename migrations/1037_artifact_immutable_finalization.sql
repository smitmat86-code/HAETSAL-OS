-- Enforce immutable managed raw identity at finalization and retain durable,
-- content-free cleanup pointers for retired legacy shared keys.
-- This migration must be applied before the compatibility Worker deploy.
-- Old Workers remain able to reserve/upload, but a legacy finalization fails
-- closed and can be retried after the protocol-aware Worker promotes it.
-- This migration must NOT be applied remotely in this session.

-- Quarantine well-formed finalized legacy operations for the separately
-- approved, non-destructive immutable-promotion pass. The exact rows remain
-- content-free operational metadata and are digest-bound before execution.
CREATE TABLE artifact_immutable_rollout_repairs (
  tenant_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  original_r2_key TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  plaintext_sha256 TEXT NOT NULL,
  ciphertext_sha256 TEXT NOT NULL,
  ciphertext_byte_length INTEGER NOT NULL,
  encryption_family TEXT NOT NULL CHECK (encryption_family IN ('tmk', 'kek')),
  canonical_capture_id TEXT NOT NULL,
  canonical_document_id TEXT NOT NULL,
  canonical_operation_id TEXT NOT NULL,
  finalization_id TEXT NOT NULL,
  repair_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (repair_state IN ('pending', 'completed')),
  approval_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, upload_id),
  UNIQUE (operation_id)
);

INSERT INTO artifact_immutable_rollout_repairs
  (tenant_id, upload_id, operation_id, artifact_id, original_r2_key,
   byte_length, plaintext_sha256, ciphertext_sha256, ciphertext_byte_length,
   encryption_family, canonical_capture_id, canonical_document_id,
   canonical_operation_id, finalization_id, created_at, updated_at)
SELECT tenant_id, upload_id, id, artifact_id, r2_key,
       byte_length, plaintext_sha256, ciphertext_sha256, ciphertext_byte_length,
       encryption_family, canonical_capture_id, canonical_document_id,
       canonical_operation_id, finalization_id,
       unixepoch('now') * 1000, unixepoch('now') * 1000
FROM artifact_intake_operations
WHERE status = 'finalized' AND adopted_attempt_token IS NULL
  AND finalization_id IS NOT NULL
  AND ciphertext_sha256 IS NOT NULL
  AND ciphertext_byte_length IS NOT NULL
  AND encryption_family IN ('tmk', 'kek')
  AND canonical_capture_id IS NOT NULL
  AND canonical_document_id IS NOT NULL
  AND canonical_operation_id IS NOT NULL;

-- Close the last pre-trigger cutover window inside the migration transaction.
-- A bound non-finalized row, or a finalized row without complete immutable-
-- promotion evidence, still aborts the entire migration.
CREATE TABLE artifact_immutable_rollout_assertion (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO artifact_immutable_rollout_assertion (invalid_count)
SELECT COUNT(*)
FROM artifact_intake_operations
WHERE adopted_attempt_token IS NULL
  AND (
    (finalization_id IS NOT NULL AND status != 'finalized')
    OR (
      status = 'finalized' AND (
        finalization_id IS NULL
        OR ciphertext_sha256 IS NULL
        OR ciphertext_byte_length IS NULL
        OR encryption_family NOT IN ('tmk', 'kek')
        OR canonical_capture_id IS NULL
        OR canonical_document_id IS NULL
        OR canonical_operation_id IS NULL
      )
    )
  );

DROP TABLE artifact_immutable_rollout_assertion;

CREATE TABLE artifact_legacy_key_tombstones (
  tenant_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  swept_at INTEGER,
  sweep_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, upload_id)
);

CREATE INDEX idx_artifact_legacy_key_tombstones_sweep
  ON artifact_legacy_key_tombstones (swept_at, created_at);

ALTER TABLE artifact_intake_operations
  ADD COLUMN immutable_finalize_authorized INTEGER NOT NULL DEFAULT 0
  CHECK (immutable_finalize_authorized IN (0, 1));

-- Old finalization binds operations before any canonical write. The shipped
-- old Worker also cannot name the new authorization column. One trigger covers
-- both transition boundaries atomically with the quarantine snapshot.
CREATE TRIGGER require_authorized_immutable_artifact_transition
BEFORE UPDATE OF finalization_id, status ON artifact_intake_operations
WHEN (
  NEW.finalization_id IS NOT NULL AND NEW.adopted_attempt_token IS NULL
) OR (
  NEW.status = 'finalized' AND (
    NEW.adopted_attempt_token IS NULL OR NEW.immutable_finalize_authorized != 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'authorized immutable artifact identity required');
-- Remote D1's trigger splitter is case- and line-ending-sensitive. Keep the
-- compound keywords uppercase and enforce LF through .gitattributes.
END;
