import { describe, expect, it } from 'vitest'
import { CANONICAL_BASE_DDL } from '../src/services/canonical-postgres-base-ddl'
import { PostgresCanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import type {
  CanonicalArtifactRecord,
  CanonicalCaptureWrite,
  CanonicalDocumentLookupRow,
} from '../src/services/canonical-postgres-schema'
import {
  createPostgresStatement,
  type PostgresSql,
  type PostgresStatement,
} from '../src/services/postgres-sql'

function createManifestSql() {
  let capture: CanonicalCaptureWrite['capture'] | null = null
  let document: CanonicalCaptureWrite['document'] | null = null
  let artifacts: CanonicalArtifactRecord[] = []
  let failNextTransaction = false
  let artifactInsertCount = 0

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = createPostgresStatement(strings, ...values)
    if (statement.text.includes('FROM haetsal_canonical.canonical_documents d')) {
      if (!capture || !document) return []
      const primary = artifacts.find(artifact => artifact.id === document!.artifact_id) ?? null
      return [{
        capture_id: capture.id,
        document_id: document.id,
        title: document.title,
        scope: capture.scope,
        source_system: capture.source_system,
        source_ref: capture.source_ref,
        captured_at: capture.captured_at,
        body_r2_key: document.body_r2_key,
        chunk_count: document.chunk_count,
        document_created_at: document.created_at,
        artifact_id: primary?.id ?? null,
        filename: primary?.filename ?? null,
        media_type: primary?.media_type ?? null,
        byte_length: primary?.byte_length ?? null,
        storage_kind: primary?.storage_kind ?? null,
        r2_key: primary?.r2_key ?? null,
      } satisfies Omit<CanonicalDocumentLookupRow, 'artifact_manifest'>]
    }
    if (statement.text.includes('FROM haetsal_canonical.canonical_artifacts a')) {
      return artifacts
        .slice()
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(artifact => ({
          artifact_id: artifact.id,
          role: artifact.role,
          parent_artifact_id: artifact.parent_artifact_id,
          storage_kind: artifact.storage_kind,
          media_type: artifact.media_type,
          filename: artifact.filename,
          byte_length: artifact.byte_length,
          sha256: artifact.sha256,
          cipher_sha256: artifact.cipher_sha256,
          encryption_family: artifact.encryption_family,
          ordinal: artifact.ordinal,
          primary: artifact.id === capture?.artifact_id,
        }))
    }
    return []
  }) as PostgresSql
  sql.query = async () => []
  sql.prepare = createPostgresStatement
  sql.transaction = async (statements: PostgresStatement[]) => {
    if (failNextTransaction) {
      failNextTransaction = false
      throw new Error('injected postgres transaction failure')
    }
    const captureStatement = statements.find(statement => statement.text.includes('INSERT INTO haetsal_canonical.canonical_captures'))!
    const documentStatement = statements.find(statement => statement.text.includes('INSERT INTO haetsal_canonical.canonical_documents'))!
    const artifactStatements = statements.filter(statement => statement.text.includes('INSERT INTO haetsal_canonical.canonical_artifacts'))
    artifactInsertCount = artifactStatements.length
    capture = {
      id: String(captureStatement.values[0]), tenant_id: String(captureStatement.values[1]),
      source_system: String(captureStatement.values[2]), source_ref: captureStatement.values[3] as string | null,
      scope: String(captureStatement.values[4]), title: captureStatement.values[5] as string | null,
      body_r2_key: String(captureStatement.values[6]), body_sha256: String(captureStatement.values[7]),
      artifact_id: captureStatement.values[8] as string | null, captured_at: Number(captureStatement.values[9]),
      created_at: Number(captureStatement.values[10]), memory_class: captureStatement.values[11] as 'episode',
      trust_state: captureStatement.values[12] as 'evidence', use_policy: captureStatement.values[13] as 'can_use_as_evidence',
      author_kind: captureStatement.values[14] as 'external_client', agent_identity: captureStatement.values[15] as string | null,
      model_runtime: captureStatement.values[16] as string | null, confidence: captureStatement.values[17] as number | null,
      retention: captureStatement.values[18] as 'standard', provenance_note: captureStatement.values[19] as string | null,
      memory_type: captureStatement.values[20] as string | null, dedup_hash: captureStatement.values[21] as string | null,
      salience_tier: captureStatement.values[22] as number | null, governance_downgraded_json: captureStatement.values[23] as string | null,
    }
    document = {
      id: String(documentStatement.values[0]), tenant_id: String(documentStatement.values[1]),
      capture_id: String(documentStatement.values[2]), artifact_id: documentStatement.values[3] as string | null,
      title: documentStatement.values[4] as string | null, body_r2_key: String(documentStatement.values[5]),
      body_sha256: String(documentStatement.values[6]), chunk_count: Number(documentStatement.values[7]),
      created_at: Number(documentStatement.values[8]),
    }
    artifacts = artifactStatements.map(statement => ({
      id: String(statement.values[0]), tenant_id: String(statement.values[1]), capture_id: String(statement.values[2]),
      storage_kind: String(statement.values[3]), r2_key: statement.values[4] as string | null,
      media_type: statement.values[5] as string | null, filename: statement.values[6] as string | null,
      byte_length: statement.values[7] as number | null, sha256: statement.values[8] as string | null,
      cipher_sha256: statement.values[9] as string | null,
      encryption_family: statement.values[10] as 'tmk' | 'kek' | 'legacy_unsealed',
      role: statement.values[11] as 'source' | 'derivative', parent_artifact_id: statement.values[12] as string | null,
      ordinal: Number(statement.values[13]), created_at: Number(statement.values[14]),
    }))
  }
  return {
    sql,
    failOnce: () => { failNextTransaction = true },
    artifactInsertCount: () => artifactInsertCount,
    hasCapture: () => Boolean(capture),
  }
}

function captureWrite(): CanonicalCaptureWrite {
  const captureId = crypto.randomUUID()
  const documentId = crypto.randomUUID()
  const sourceId = crypto.randomUUID()
  const firstDerivativeId = crypto.randomUUID()
  const secondDerivativeId = crypto.randomUUID()
  const createdAt = Date.now()
  const lineage: Array<Pick<CanonicalArtifactRecord, 'id' | 'role' | 'parent_artifact_id' | 'ordinal'>> = [
    { id: sourceId, role: 'source', parent_artifact_id: null, ordinal: 0 },
    { id: firstDerivativeId, role: 'derivative', parent_artifact_id: sourceId, ordinal: 1 },
    { id: secondDerivativeId, role: 'derivative', parent_artifact_id: firstDerivativeId, ordinal: 2 },
  ]
  const artifacts: CanonicalArtifactRecord[] = lineage.map((artifact, index) => ({
    ...artifact,
    tenant_id: 'tenant-postgres-manifest', capture_id: captureId, storage_kind: 'managed_r2',
    r2_key: `artifact-intake/v1/tenant/${artifact.id}.enc`, media_type: 'text/plain',
    filename: `artifact-${index}.txt`, byte_length: 10 + index, sha256: `${index}`.repeat(64),
    cipher_sha256: `${index + 3}`.repeat(64), encryption_family: 'tmk', created_at: createdAt,
  }))
  return {
    capture: {
      id: captureId, tenant_id: 'tenant-postgres-manifest', source_system: 'file', source_ref: null,
      scope: 'research', title: 'Manifest', body_r2_key: `canonical/tenant/documents/${documentId}.enc`,
      body_sha256: 'a'.repeat(64), artifact_id: sourceId, captured_at: createdAt, created_at: createdAt,
      memory_class: 'episode', trust_state: 'evidence', use_policy: 'can_use_as_evidence',
      author_kind: 'external_client', agent_identity: 'Codex', model_runtime: null, confidence: null,
      retention: 'standard', provenance_note: null, memory_type: null, dedup_hash: null,
      salience_tier: null, governance_downgraded_json: null,
    },
    artifacts,
    document: {
      id: documentId, tenant_id: 'tenant-postgres-manifest', capture_id: captureId, artifact_id: sourceId,
      title: 'Manifest', body_r2_key: `canonical/tenant/documents/${documentId}.enc`, body_sha256: 'a'.repeat(64),
      chunk_count: 1, created_at: createdAt,
    },
    chunks: [],
    operation: {
      id: crypto.randomUUID(), tenant_id: 'tenant-postgres-manifest', capture_id: captureId,
      operation_type: 'capture.accepted', status: 'accepted', created_at: createdAt, updated_at: createdAt,
    },
    projectionJobs: [],
    event: null,
  }
}

describe('12.5 concrete Postgres canonical artifact manifest', () => {
  it('evolves additively and atomically round-trips source plus derivatives with the primary pointer', async () => {
    const ddl = CANONICAL_BASE_DDL.join('\n')
    for (const column of ['role', 'parent_artifact_id', 'encryption_family', 'cipher_sha256', 'ordinal']) {
      expect(ddl).toContain(`ADD COLUMN IF NOT EXISTS ${column}`)
    }

    const fake = createManifestSql()
    const store = new PostgresCanonicalMemoryStore(fake.sql)
    const write = captureWrite()
    fake.failOnce()
    await expect(store.writeCapture(write)).rejects.toThrow('injected postgres transaction failure')
    expect(fake.hasCapture()).toBe(false)

    await store.writeCapture(write)
    expect(fake.artifactInsertCount()).toBe(3)
    const document = await store.getDocument(write.capture.tenant_id, write.document.id)
    expect(document?.artifact_id).toBe(write.capture.artifact_id)
    expect(document?.artifact_manifest.map(artifact => [
      artifact.role, artifact.parent_artifact_id, artifact.primary,
    ])).toEqual([
      ['source', null, true],
      ['derivative', write.artifacts[0]!.id, false],
      ['derivative', write.artifacts[1]!.id, false],
    ])
  })
})
