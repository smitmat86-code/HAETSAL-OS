-- Fenced artifact upload ownership (expand phase).
-- All fields remain content-free operational metadata.
--
-- Sequencing contract (expand / deploy / enforce):
--   1. EXPAND (this migration): add nullable columns only. The currently
--      deployed old Worker ignores them; its INSERTs name explicit columns and
--      its UPDATEs never touch these, so it remains fully compatible.
--   2. DEPLOY: ship the Worker that claims upload_attempt_token before any
--      upload mutation, writes each attempt to a unique immutable R2 key, and
--      CAS-adopts exactly one attempt into r2_key/adopted_attempt_token.
--   3. ENFORCE: only after the old Worker has provably drained may any process
--      assume every sealed row was adopted through an attempt token. Rows
--      sealed before enforcement keep adopted_attempt_token NULL and continue
--      to prove against the legacy per-upload key.
-- This migration must NOT be applied remotely in this session.

ALTER TABLE artifact_intake_operations ADD COLUMN upload_attempt_token TEXT;
ALTER TABLE artifact_intake_operations ADD COLUMN upload_attempt_expires_at INTEGER;
ALTER TABLE artifact_intake_operations ADD COLUMN adopted_attempt_token TEXT;
