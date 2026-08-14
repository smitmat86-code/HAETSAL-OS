-- Governed artifact intake operational ledger.
-- Metadata only: filenames, URLs, captions, prompts, extractions, and file
-- bodies are deliberately absent from every table in this migration.

CREATE TABLE IF NOT EXISTS artifact_intake_operations (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  upload_id                TEXT NOT NULL,
  idempotency_hash         TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('reserved', 'sealed', 'finalized', 'failed', 'expired')),
  error_code               TEXT,
  artifact_id              TEXT NOT NULL,
  r2_key                   TEXT NOT NULL,
  declared_mime_category   TEXT,
  detected_mime_category   TEXT,
  byte_length              INTEGER NOT NULL,
  plaintext_sha256         TEXT NOT NULL,
  ciphertext_sha256        TEXT,
  encryption_family        TEXT CHECK (encryption_family IN ('tmk', 'kek')),
  canonical_capture_id     TEXT,
  canonical_document_id    TEXT,
  canonical_operation_id   TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE (tenant_id, upload_id),
  UNIQUE (tenant_id, idempotency_hash)
);

CREATE INDEX IF NOT EXISTS idx_artifact_intake_operations_status_expiry
  ON artifact_intake_operations(tenant_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_artifact_intake_operations_canonical_capture
  ON artifact_intake_operations(tenant_id, canonical_capture_id);

CREATE TABLE IF NOT EXISTS artifact_intake_finalizations (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  idempotency_hash         TEXT NOT NULL,
  manifest_sha256          TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('reserved', 'finalized', 'failed')),
  error_code               TEXT,
  canonical_capture_id     TEXT NOT NULL,
  canonical_document_id    TEXT NOT NULL,
  canonical_operation_id   TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE (tenant_id, idempotency_hash)
);

CREATE INDEX IF NOT EXISTS idx_artifact_intake_finalizations_status
  ON artifact_intake_finalizations(tenant_id, status, updated_at);
