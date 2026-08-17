import { PGlite } from '@electric-sql/pglite'
import type { TestProject } from 'vitest/node'
import { LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL } from '../src/services/artifact-intake/legacy-managed-replacements'
import type { LegacyManagedReplacementQueryRow } from '../src/services/artifact-intake/legacy-inventory-types'

export interface LegacyPostgresBoundaryProof {
  rows: LegacyManagedReplacementQueryRow[]
  explain: string[]
}

declare module 'vitest' {
  export interface ProvidedContext {
    legacyPostgresBoundary: LegacyPostgresBoundaryProof
  }
}

const fixtureSql = `
  CREATE SCHEMA haetsal_canonical;
  CREATE TABLE haetsal_canonical.canonical_captures (
    id text PRIMARY KEY, tenant_id text NOT NULL, artifact_id text
  );
  CREATE TABLE haetsal_canonical.canonical_artifacts (
    id text PRIMARY KEY, tenant_id text NOT NULL, capture_id text NOT NULL,
    storage_kind text NOT NULL, r2_key text
  );
  CREATE TABLE haetsal_canonical.canonical_documents (
    id text PRIMARY KEY, tenant_id text NOT NULL, capture_id text NOT NULL, artifact_id text
  );

  INSERT INTO haetsal_canonical.canonical_captures (id, tenant_id, artifact_id) VALUES
    ('valid', 'tenant', 'managed-valid'),
    ('derivative', 'tenant', 'managed-derivative'),
    ('mixed', 'tenant', 'managed-mixed'),
    ('missing-document', 'tenant', 'managed-missing'),
    ('conflicting-documents', 'tenant', 'managed-conflicting'),
    ('multiple-legacy', 'tenant', 'managed-multiple'),
    ('mismatched-capture', 'tenant', 'managed-foreign'),
    ('pre-role', 'tenant', 'managed-pre-role'),
    ('managed-owner', 'tenant', NULL);

  -- This row predates the role column. The subsequent DEFAULT source value is
  -- schema history, not provenance, and must not make it deletion-eligible.
  INSERT INTO haetsal_canonical.canonical_artifacts
    (id, tenant_id, capture_id, storage_kind, r2_key) VALUES
    ('legacy-pre-role', 'tenant', 'pre-role', 'legacy_r2', 'telegram-media/tenant/pre-role');
  ALTER TABLE haetsal_canonical.canonical_artifacts
    ADD COLUMN role text NOT NULL DEFAULT 'source';

  INSERT INTO haetsal_canonical.canonical_artifacts
    (id, tenant_id, capture_id, storage_kind, r2_key, role) VALUES
    ('legacy-valid', 'tenant', 'valid', 'legacy_r2', 'telegram-media/tenant/valid', 'source'),
    ('managed-valid', 'tenant', 'valid', 'managed_r2', 'artifact-intake/v1/valid', 'source'),
    ('legacy-derivative', 'tenant', 'derivative', 'legacy_r2', 'telegram-media/tenant/derivative', 'derivative'),
    ('managed-derivative', 'tenant', 'derivative', 'managed_r2', 'artifact-intake/v1/derivative', 'source'),
    ('legacy-mixed-source', 'tenant', 'mixed', 'legacy_r2', 'telegram-media/tenant/mixed-source', 'source'),
    ('legacy-mixed-derivative', 'tenant', 'mixed', 'legacy_r2', 'telegram-media/tenant/mixed-derivative', 'derivative'),
    ('managed-mixed', 'tenant', 'mixed', 'managed_r2', 'artifact-intake/v1/mixed', 'source'),
    ('legacy-missing', 'tenant', 'missing-document', 'legacy_r2', 'telegram-media/tenant/missing', 'source'),
    ('managed-missing', 'tenant', 'missing-document', 'managed_r2', 'artifact-intake/v1/missing', 'source'),
    ('legacy-conflicting', 'tenant', 'conflicting-documents', 'legacy_r2', 'telegram-media/tenant/conflicting', 'source'),
    ('managed-conflicting', 'tenant', 'conflicting-documents', 'managed_r2', 'artifact-intake/v1/conflicting', 'source'),
    ('managed-conflicting-other', 'tenant', 'conflicting-documents', 'managed_r2', 'artifact-intake/v1/conflicting-other', 'derivative'),
    ('legacy-multiple-a', 'tenant', 'multiple-legacy', 'legacy_r2', 'telegram-media/tenant/multiple-a', 'source'),
    ('legacy-multiple-b', 'tenant', 'multiple-legacy', 'legacy_r2', 'telegram-media/tenant/multiple-b', 'source'),
    ('managed-multiple', 'tenant', 'multiple-legacy', 'managed_r2', 'artifact-intake/v1/multiple', 'source'),
    ('legacy-mismatch', 'tenant', 'mismatched-capture', 'legacy_r2', 'telegram-media/tenant/mismatch', 'source'),
    ('managed-foreign', 'tenant', 'managed-owner', 'managed_r2', 'artifact-intake/v1/foreign', 'source');
  INSERT INTO haetsal_canonical.canonical_artifacts
    (id, tenant_id, capture_id, storage_kind, r2_key, role) VALUES
    ('managed-pre-role', 'tenant', 'pre-role', 'managed_r2', 'artifact-intake/v1/pre-role', 'source');

  INSERT INTO haetsal_canonical.canonical_documents (id, tenant_id, capture_id, artifact_id) VALUES
    ('doc-valid', 'tenant', 'valid', 'managed-valid'),
    ('doc-derivative', 'tenant', 'derivative', 'managed-derivative'),
    ('doc-mixed', 'tenant', 'mixed', 'managed-mixed'),
    ('doc-conflicting-a', 'tenant', 'conflicting-documents', 'managed-conflicting'),
    ('doc-conflicting-b', 'tenant', 'conflicting-documents', 'managed-conflicting-other'),
    ('doc-multiple', 'tenant', 'multiple-legacy', 'managed-multiple'),
    ('doc-mismatch', 'tenant', 'mismatched-capture', 'managed-foreign');
  INSERT INTO haetsal_canonical.canonical_documents (id, tenant_id, capture_id, artifact_id) VALUES
    ('doc-pre-role', 'tenant', 'pre-role', 'managed-pre-role');
`

function serializableRows(rows: LegacyManagedReplacementQueryRow[]): LegacyManagedReplacementQueryRow[] {
  return rows.map(row => ({
    ...row,
    legacy_artifact_count: String(row.legacy_artifact_count),
    eligible_legacy_source_count: String(row.eligible_legacy_source_count),
    managed_primary_source_count: String(row.managed_primary_source_count),
  }))
}

export default async function setup(project: TestProject): Promise<void> {
  const postgres = new PGlite()
  await postgres.exec(fixtureSql)
  const result = await postgres.query<LegacyManagedReplacementQueryRow>(LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL)
  const explained = await postgres.query<Record<string, unknown>>(`EXPLAIN ${LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL}`)
  project.provide('legacyPostgresBoundary', {
    rows: serializableRows(result.rows),
    explain: explained.rows.map(row => String(row['QUERY PLAN'])),
  })
  await postgres.close()
}
