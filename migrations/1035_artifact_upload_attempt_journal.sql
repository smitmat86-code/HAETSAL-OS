-- Crash-safe orphan-attempt journal (expand-only, content-free).
-- One row is written before each fenced upload attempt's R2 put. If the
-- process dies between the put and adoption, the row is the only durable
-- pointer to the abandoned unique attempt object; a bounded sweeper deletes
-- the object after the attempt lease plus a full write-lifetime grace window
-- and proves against D1 that the attempt was never adopted.
-- Contains identifiers and timestamps only: no filenames, captions, bodies,
-- locators, or extracted content.
-- This migration must NOT be applied remotely in this session.

CREATE TABLE artifact_upload_attempts (
  tenant_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  attempt_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, upload_id, attempt_token)
);

CREATE INDEX idx_artifact_upload_attempts_lease
  ON artifact_upload_attempts (lease_expires_at);
