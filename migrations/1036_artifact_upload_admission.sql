-- Operator-controlled artifact upload admission gate (expand-only,
-- content-free: a single fixed-vocabulary state and a timestamp).
--
-- During the old -> compat -> active rollout boundary the operator closes the
-- gate before activation. Protocol-aware Workers refuse every new artifact
-- upload mutation (reserve, byte upload, replay) with the retryable
-- upload_admission_closed error while the gate is closed, and FAIL CLOSED if
-- the gate cannot be read. The previously deployed old Worker does not read
-- this table; the gate therefore bounds new-writer mutations only and is
-- defense in depth on top of the plaintext-verified sealed-identity
-- convergence protocol, which keeps overlapping old/new writers safe without
-- assuming any HTTP request lifetime.
-- Absence of the row means "open" (normal operation).
-- This migration must NOT be applied remotely in this session.

CREATE TABLE artifact_intake_admission (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  updated_at INTEGER NOT NULL
);
