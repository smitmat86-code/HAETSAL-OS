-- Content-free operational state for governed Telegram and Sendblue media.
-- Provider locators, URLs, reply targets, captions, filenames, bodies, and
-- extraction text live only in an expiring tenant-encrypted R2 handoff.

CREATE TABLE IF NOT EXISTS channel_media_jobs (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  provider                 TEXT NOT NULL CHECK (provider IN ('telegram', 'sendblue')),
  event_identity_hash      TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN
    ('accepted', 'processing', 'retryable', 'finalized', 'delivered', 'failed', 'delivery_unknown')),
  error_code               TEXT,
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  lease_token              TEXT,
  lease_expires_at         INTEGER,
  delivery_status          TEXT NOT NULL CHECK (delivery_status IN
    ('pending', 'claimed', 'delivered', 'failed', 'unknown')),
  handoff_status           TEXT NOT NULL DEFAULT 'pending' CHECK (handoff_status IN ('pending', 'deleted')),
  artifact_upload_id       TEXT,
  canonical_capture_id     TEXT,
  canonical_document_id    TEXT,
  canonical_operation_id   TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE (tenant_id, provider, event_identity_hash)
);

CREATE INDEX IF NOT EXISTS idx_channel_media_jobs_status
  ON channel_media_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_channel_media_jobs_expiry
  ON channel_media_jobs(expires_at, status);
