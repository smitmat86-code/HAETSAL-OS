CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_documents (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  stable_key  TEXT NOT NULL,
  family      TEXT NOT NULL,
  scope       TEXT NOT NULL,
  title       TEXT,
  summary     TEXT,
  audience    TEXT NOT NULL,
  compiled_at BIGINT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_documents_tenant_stable
  ON haetsal_canonical.compiled_documents(tenant_id, stable_key);

CREATE INDEX IF NOT EXISTS idx_pg_compiled_documents_tenant_family
  ON haetsal_canonical.compiled_documents(tenant_id, family, scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_document_sources (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  source_role          TEXT NOT NULL,
  canonical_capture_id TEXT REFERENCES haetsal_canonical.canonical_captures(id) ON DELETE CASCADE,
  canonical_document_id TEXT REFERENCES haetsal_canonical.canonical_documents(id) ON DELETE CASCADE,
  canonical_artifact_id TEXT REFERENCES haetsal_canonical.canonical_artifacts(id) ON DELETE CASCADE,
  canonical_operation_id TEXT REFERENCES haetsal_canonical.canonical_memory_operations(id) ON DELETE CASCADE,
  created_at           BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_compiled_document_sources_lookup
  ON haetsal_canonical.compiled_document_sources(tenant_id, compiled_document_id, source_role);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_document_artifacts (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  artifact_role        TEXT NOT NULL,
  format               TEXT NOT NULL,
  version              TEXT NOT NULL,
  media_type           TEXT,
  r2_key               TEXT NOT NULL,
  sha256               TEXT NOT NULL,
  byte_length          BIGINT NOT NULL,
  created_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_document_artifacts_version
  ON haetsal_canonical.compiled_document_artifacts(tenant_id, compiled_document_id, artifact_role, version);

CREATE INDEX IF NOT EXISTS idx_pg_compiled_document_artifacts_lookup
  ON haetsal_canonical.compiled_document_artifacts(tenant_id, compiled_document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_entities (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key           TEXT NOT NULL,
  scope                TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  name                 TEXT NOT NULL,
  summary              TEXT,
  compiled_at          BIGINT NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_entities_tenant_stable
  ON haetsal_canonical.compiled_entities(tenant_id, stable_key);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_facts (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key           TEXT NOT NULL,
  scope                TEXT NOT NULL,
  subject_entity_id    TEXT REFERENCES haetsal_canonical.compiled_entities(id) ON DELETE SET NULL,
  fact_type            TEXT NOT NULL,
  value_json           TEXT NOT NULL,
  summary              TEXT,
  compiled_at          BIGINT NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_facts_tenant_stable
  ON haetsal_canonical.compiled_facts(tenant_id, stable_key);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_relationships (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key           TEXT NOT NULL,
  scope                TEXT NOT NULL,
  subject_entity_id    TEXT REFERENCES haetsal_canonical.compiled_entities(id) ON DELETE SET NULL,
  object_entity_id     TEXT REFERENCES haetsal_canonical.compiled_entities(id) ON DELETE SET NULL,
  relationship_type    TEXT NOT NULL,
  summary              TEXT,
  compiled_at          BIGINT NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_relationships_tenant_stable
  ON haetsal_canonical.compiled_relationships(tenant_id, stable_key);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_contradictions (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key           TEXT NOT NULL,
  scope                TEXT NOT NULL,
  left_fact_id         TEXT REFERENCES haetsal_canonical.compiled_facts(id) ON DELETE SET NULL,
  right_fact_id        TEXT REFERENCES haetsal_canonical.compiled_facts(id) ON DELETE SET NULL,
  title                TEXT,
  summary              TEXT NOT NULL,
  status               TEXT NOT NULL,
  compiled_at          BIGINT NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_contradictions_tenant_stable
  ON haetsal_canonical.compiled_contradictions(tenant_id, stable_key);

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_context_packs (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  compiled_document_id TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key           TEXT NOT NULL,
  scope                TEXT NOT NULL,
  pack_kind            TEXT NOT NULL,
  title                TEXT NOT NULL,
  summary              TEXT,
  agent_usable         BOOLEAN NOT NULL,
  human_usable         BOOLEAN NOT NULL,
  compiled_at          BIGINT NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_context_packs_tenant_stable
  ON haetsal_canonical.compiled_context_packs(tenant_id, stable_key);
