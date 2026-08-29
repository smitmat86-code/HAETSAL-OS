-- Fenced artifact upload ownership (expand phase).
-- All fields remain content-free operational metadata.
--
-- Rollout contract (expand / compatibility / drain / activate / enforce).
-- The old Worker (1e4d3a6) mutates upload rows guarded only by
-- status != 'finalized'; no D1 predicate can stop it from overwriting an
-- attempt-adopted row. Safety therefore comes from never creating an
-- attempt-adoptable row while an old writer can still run:
--   1. EXPAND (this migration): add nullable columns only. The currently
--      deployed old Worker ignores them; its INSERTs name explicit columns and
--      its UPDATEs never touch these, so it remains fully compatible.
--   2. COMPATIBILITY deploy: ship the protocol-aware Worker with
--      ARTIFACT_UPLOAD_PROTOCOL_PHASE = "compat". It reserves rows with
--      upload_protocol NULL (legacy) and uploads them through the legacy
--      per-upload key exactly like the old Worker, adding only D1 attempt
--      fencing the old Worker ignores. Gradual deployment old -> compat is
--      permitted: both versions write the same key for the same row.
--   3. DRAIN: verify via version analytics that zero old-version requests
--      remain, then wait one full Worker request lifetime plus
--      ARTIFACT_UPLOAD_EXPIRY_MS so every operation an old isolate could
--      still hold is terminal or expired.
--   4. ACTIVATE: redeploy with ARTIFACT_UPLOAD_PROTOCOL_PHASE = "active".
--      Only now are rows reserved with upload_protocol = 'fenced_v2', the
--      only rows on which attempt-key adoption is enabled. Gradual
--      deployment compat -> active is permitted: both builds dispatch the
--      upload path on the row's recorded upload_protocol, never on their own
--      phase. Gradual deployment old -> active is PROHIBITED.
--   5. ENFORCE (later audit): once every legacy row has expired, every newly
--      sealed row must carry adopted_attempt_token; legacy rows sealed before
--      activation keep adopted_attempt_token NULL and continue to prove
--      against the legacy per-upload key.
-- This migration must NOT be applied remotely in this session.

ALTER TABLE artifact_intake_operations ADD COLUMN upload_attempt_token TEXT;
ALTER TABLE artifact_intake_operations ADD COLUMN upload_attempt_expires_at INTEGER;
ALTER TABLE artifact_intake_operations ADD COLUMN adopted_attempt_token TEXT;
ALTER TABLE artifact_intake_operations ADD COLUMN upload_protocol TEXT;
