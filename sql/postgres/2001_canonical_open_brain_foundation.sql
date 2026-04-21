CREATE SCHEMA IF NOT EXISTS haetsal_canonical;

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_captures (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_ref    TEXT,
  scope         TEXT NOT NULL,
  title         TEXT,
  body_r2_key   TEXT NOT NULL,
  body_sha256   TEXT NOT NULL,
  artifact_id   TEXT,
  captured_at   BIGINT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_captures_tenant_source
  ON haetsal_canonical.canonical_captures(tenant_id, source_system, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_captures_tenant_scope
  ON haetsal_canonical.canonical_captures(tenant_id, scope, created_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_artifacts (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  capture_id   TEXT NOT NULL REFERENCES haetsal_canonical.canonical_captures(id) ON DELETE CASCADE,
  storage_kind TEXT NOT NULL,
  r2_key       TEXT,
  media_type   TEXT,
  filename     TEXT,
  byte_length  BIGINT,
  sha256       TEXT,
  created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_artifacts_tenant_created
  ON haetsal_canonical.canonical_artifacts(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_documents (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  capture_id  TEXT NOT NULL REFERENCES haetsal_canonical.canonical_captures(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES haetsal_canonical.canonical_artifacts(id) ON DELETE SET NULL,
  title       TEXT,
  body_r2_key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_documents_tenant_capture
  ON haetsal_canonical.canonical_documents(tenant_id, capture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_chunks (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  document_id  TEXT NOT NULL REFERENCES haetsal_canonical.canonical_documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  chunk_sha256 TEXT NOT NULL,
  created_at   BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_chunks_document_ordinal
  ON haetsal_canonical.canonical_chunks(document_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_chunks_tenant_document
  ON haetsal_canonical.canonical_chunks(tenant_id, document_id);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_memory_operations (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  capture_id     TEXT NOT NULL REFERENCES haetsal_canonical.canonical_captures(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_memory_operations_tenant_status
  ON haetsal_canonical.canonical_memory_operations(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_projection_jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  operation_id    TEXT NOT NULL REFERENCES haetsal_canonical.canonical_memory_operations(id) ON DELETE CASCADE,
  capture_id      TEXT NOT NULL REFERENCES haetsal_canonical.canonical_captures(id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL REFERENCES haetsal_canonical.canonical_documents(id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  enqueued_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_projection_jobs_tenant_status
  ON haetsal_canonical.canonical_projection_jobs(tenant_id, projection_kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_projection_results (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  projection_job_id   TEXT NOT NULL REFERENCES haetsal_canonical.canonical_projection_jobs(id) ON DELETE CASCADE,
  status              TEXT NOT NULL,
  target_ref          TEXT,
  error_message       TEXT,
  engine_bank_id      TEXT,
  engine_document_id  TEXT,
  engine_operation_id TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_projection_results_tenant_status
  ON haetsal_canonical.canonical_projection_results(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_projection_results_operation
  ON haetsal_canonical.canonical_projection_results(engine_operation_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.canonical_graph_identity_mappings (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  projection_job_id TEXT NOT NULL REFERENCES haetsal_canonical.canonical_projection_jobs(id) ON DELETE CASCADE,
  canonical_key     TEXT NOT NULL,
  graph_ref         TEXT NOT NULL,
  graph_kind        TEXT NOT NULL,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_graph_identity_unique
  ON haetsal_canonical.canonical_graph_identity_mappings(projection_job_id, canonical_key, graph_kind);

CREATE INDEX IF NOT EXISTS idx_pg_canonical_graph_identity_lookup
  ON haetsal_canonical.canonical_graph_identity_mappings(tenant_id, canonical_key, graph_kind, updated_at DESC);
