-- Content-free lifecycle telemetry for governed artifact intake.
-- Defensive drops also make local migration replay safe after prerelease
-- versions that briefly used triggers (trigger side-effects distorted D1
-- mutation counts used by the lifecycle CAS protocol).
DROP TRIGGER IF EXISTS artifact_intake_event_reserved;
DROP TRIGGER IF EXISTS artifact_intake_event_transition;

CREATE TABLE IF NOT EXISTS artifact_intake_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'reserved', 'sealed', 'finalized', 'failed', 'expired', 'reaped'
  )),
  occurred_at INTEGER NOT NULL,
  error_code TEXT,
  UNIQUE (operation_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_artifact_intake_events_tenant_time
  ON artifact_intake_events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_intake_events_type_time
  ON artifact_intake_events(event_type, occurred_at DESC);
