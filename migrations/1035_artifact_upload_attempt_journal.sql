-- Crash-safe orphan-attempt journal (expand-only, content-free).
-- One row is written before each fenced upload attempt's R2 put. If the
-- process dies around the put, the row is the only durable pointer to the
-- abandoned unique attempt object. Because an HTTP-triggered Worker has no
-- hard wall-time limit, the put may land arbitrarily late; the row is
-- therefore a TOMBSTONE that a bounded sweeper re-checks by exact key until
-- either the attempt is adopted or an object was actually observed, deleted,
-- and confirmed absent on a later sweep. Absence during a single check never
-- retires the pointer.
-- Tombstone lifecycle fields: swept_at / sweep_count pace and order
-- re-checks; resolved_at records that an object at the exact key was
-- observed and deleted, after which one later absent confirmation retires
-- the row (one attempt token performs at most one logical put).
-- Contains identifiers and timestamps only: no filenames, captions, bodies,
-- locators, or extracted content.
-- This migration was never applied to any environment and is edited in place
-- while still pending. It must NOT be applied remotely in this session.

CREATE TABLE artifact_upload_attempts (
  tenant_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  attempt_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  swept_at INTEGER,
  sweep_count INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  PRIMARY KEY (tenant_id, upload_id, attempt_token)
);

CREATE INDEX idx_artifact_upload_attempts_lease
  ON artifact_upload_attempts (lease_expires_at);
