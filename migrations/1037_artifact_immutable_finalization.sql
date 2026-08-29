-- Enforce immutable managed raw identity at finalization and retain durable,
-- content-free cleanup pointers for retired legacy shared keys.
-- This migration must be applied before the compatibility Worker deploy.
-- Old Workers remain able to reserve/upload, but a legacy finalization fails
-- closed and can be retried after the protocol-aware Worker promotes it.
-- This migration must NOT be applied remotely in this session.

-- Close the last pre-trigger cutover window inside the migration transaction.
-- If an old finalizer already bound a mutable operation, abort the entire
-- migration so an operator can perform a separately governed repair first.
CREATE TABLE artifact_immutable_rollout_assertion (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO artifact_immutable_rollout_assertion (invalid_count)
SELECT COUNT(*)
FROM artifact_intake_operations
WHERE adopted_attempt_token IS NULL
  AND (finalization_id IS NOT NULL OR status = 'finalized');

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

-- Old finalization binds operations before any canonical write. Reject a
-- legacy binding at that boundary, before Neon can observe a mutable key.
CREATE TRIGGER require_immutable_artifact_before_binding
BEFORE UPDATE OF finalization_id ON artifact_intake_operations
WHEN NEW.finalization_id IS NOT NULL AND NEW.adopted_attempt_token IS NULL
BEGIN
  SELECT RAISE(ABORT, 'immutable artifact identity required before binding');
END;

-- The shipped old Worker cannot name this new authorization column. New code
-- sets it only inside the exact-identity terminal CAS.
CREATE TRIGGER require_authorized_immutable_artifact_finalize
BEFORE UPDATE OF status ON artifact_intake_operations
WHEN NEW.status = 'finalized' AND (
  NEW.adopted_attempt_token IS NULL OR NEW.immutable_finalize_authorized != 1
)
BEGIN
  SELECT RAISE(ABORT, 'authorized immutable artifact required before finalization');
END;
