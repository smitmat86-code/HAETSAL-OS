ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS contradiction_kind TEXT NOT NULL DEFAULT 'claim_conflict';

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS conflict_scope TEXT;

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium';

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS freshness TEXT NOT NULL DEFAULT 'recent';

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS left_claim_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS right_claim_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS suggested_resolution TEXT;

ALTER TABLE haetsal_canonical.compiled_contradictions
  ADD COLUMN IF NOT EXISTS resolution_summary TEXT;

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_dossiers (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  compiled_document_id     TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key               TEXT NOT NULL,
  scope                    TEXT NOT NULL,
  dossier_kind             TEXT NOT NULL,
  subject_type             TEXT NOT NULL,
  subject_stable_key       TEXT NOT NULL,
  subject_name             TEXT NOT NULL,
  why_it_matters           TEXT,
  current_state            TEXT,
  key_facts_json           TEXT NOT NULL DEFAULT '[]',
  key_relationships_json   TEXT NOT NULL DEFAULT '[]',
  recent_updates_json      TEXT NOT NULL DEFAULT '[]',
  open_questions_json      TEXT NOT NULL DEFAULT '[]',
  contradiction_refs_json  TEXT NOT NULL DEFAULT '[]',
  recommended_actions_json TEXT NOT NULL DEFAULT '[]',
  recommended_reading_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json         TEXT NOT NULL DEFAULT '[]',
  compiled_at              BIGINT NOT NULL,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_dossiers_tenant_stable
  ON haetsal_canonical.compiled_dossiers(tenant_id, stable_key);

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS situation TEXT;

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS critical_facts_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS recent_changes_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS decisions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS contradictions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS recommended_actions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE haetsal_canonical.compiled_context_packs
  ADD COLUMN IF NOT EXISTS source_refs_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS haetsal_canonical.compiled_change_views (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  compiled_document_id     TEXT NOT NULL REFERENCES haetsal_canonical.compiled_documents(id) ON DELETE CASCADE,
  stable_key               TEXT NOT NULL,
  scope                    TEXT NOT NULL,
  view_kind                TEXT NOT NULL,
  title                    TEXT NOT NULL,
  summary                  TEXT,
  decisions_json           TEXT NOT NULL DEFAULT '[]',
  changes_json             TEXT NOT NULL DEFAULT '[]',
  contradictions_json      TEXT NOT NULL DEFAULT '[]',
  recommended_actions_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json         TEXT NOT NULL DEFAULT '[]',
  compiled_at              BIGINT NOT NULL,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_compiled_change_views_tenant_stable
  ON haetsal_canonical.compiled_change_views(tenant_id, stable_key);
