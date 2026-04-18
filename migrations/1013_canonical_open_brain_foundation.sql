-- Canonical open-brain foundation bridge
-- Session 6.1 lands canonical metadata in D1 while preserving encrypted payloads in R2.
-- No raw memory content is stored in D1.

CREATE TABLE IF NOT EXISTS canonical_captures (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_ref    TEXT,
  scope         TEXT NOT NULL,
  title         TEXT,
  body_r2_key   TEXT NOT NULL, -- encrypted canonical body in R2_ARTIFACTS
  body_sha256   TEXT NOT NULL,
  artifact_id   TEXT,
  captured_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_captures_tenant_source
  ON canonical_captures(tenant_id, source_system, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_captures_tenant_scope
  ON canonical_captures(tenant_id, scope, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_artifacts (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  capture_id   TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  r2_key       TEXT, -- encrypted artifact payload or external pointer key
  media_type   TEXT,
  filename     TEXT,
  byte_length  INTEGER,
  sha256       TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (capture_id) REFERENCES canonical_captures(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_artifacts_tenant_created
  ON canonical_artifacts(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_documents (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  capture_id  TEXT NOT NULL,
  artifact_id TEXT,
  title       TEXT,
  body_r2_key TEXT NOT NULL, -- encrypted normalized document body in R2_ARTIFACTS
  body_sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (capture_id) REFERENCES canonical_captures(id),
  FOREIGN KEY (artifact_id) REFERENCES canonical_artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_documents_tenant_capture
  ON canonical_documents(tenant_id, capture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_chunks (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  document_id  TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  chunk_sha256 TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (document_id) REFERENCES canonical_documents(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_chunks_document_ordinal
  ON canonical_chunks(document_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_canonical_chunks_tenant_document
  ON canonical_chunks(tenant_id, document_id);

CREATE TABLE IF NOT EXISTS canonical_memory_operations (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  capture_id     TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (capture_id) REFERENCES canonical_captures(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_memory_operations_tenant_status
  ON canonical_memory_operations(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_projection_jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  operation_id    TEXT NOT NULL,
  capture_id      TEXT NOT NULL,
  document_id     TEXT NOT NULL,
  projection_kind TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (operation_id) REFERENCES canonical_memory_operations(id),
  FOREIGN KEY (capture_id) REFERENCES canonical_captures(id),
  FOREIGN KEY (document_id) REFERENCES canonical_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_projection_jobs_tenant_status
  ON canonical_projection_jobs(tenant_id, projection_kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_projection_results (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  projection_job_id TEXT NOT NULL,
  status            TEXT NOT NULL,
  target_ref        TEXT,
  error_message     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (projection_job_id) REFERENCES canonical_projection_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_projection_results_tenant_status
  ON canonical_projection_results(tenant_id, status, created_at DESC);
