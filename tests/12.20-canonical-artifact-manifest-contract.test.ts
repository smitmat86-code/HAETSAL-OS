import { describe, expect, it } from 'vitest'
import { toNormalizedArtifacts } from '../src/services/canonical-memory-types'
import { PostgresCanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import type {
  CanonicalArtifactRecord,
  CanonicalCaptureWrite,
} from '../src/services/canonical-postgres-schema'
import { createPostgresStatement, type PostgresSql, type PostgresStatement } from '../src/services/postgres-sql'

const TENANT = 'tenant-canonical-manifest-contract'

function stubSql(): { sql: PostgresSql; transactions: () => number } {
  let transactions = 0
  const sql = (async () => []) as unknown as PostgresSql
  sql.query = async () => []
  sql.prepare = createPostgresStatement
  sql.transaction = async (_statements: PostgresStatement[]) => { transactions += 1 }
  return { sql, transactions: () => transactions }
}

type ArtifactShape = Pick<CanonicalArtifactRecord, 'id' | 'role' | 'parent_artifact_id' | 'ordinal'>

function captureWrite(shapes: ArtifactShape[], primaryId: string | null): CanonicalCaptureWrite {
  const captureId = crypto.randomUUID()
  const documentId = crypto.randomUUID()
  const createdAt = Date.now()
  const artifacts: CanonicalArtifactRecord[] = shapes.map((shape, index) => ({
    ...shape,
    tenant_id: TENANT, capture_id: captureId, storage_kind: 'managed_r2',
    r2_key: `artifact-intake/v1/tenant/${shape.id}.enc`, media_type: 'text/plain',
    filename: `artifact-${index}.txt`, byte_length: 10 + index, sha256: 'b'.repeat(64),
    cipher_sha256: 'c'.repeat(64), encryption_family: 'tmk', created_at: createdAt,
  }))
  return {
    capture: {
      id: captureId, tenant_id: TENANT, source_system: 'file', source_ref: null,
      scope: 'research', title: 'Contract', body_r2_key: `canonical/tenant/documents/${documentId}.enc`,
      body_sha256: 'a'.repeat(64), artifact_id: primaryId, captured_at: createdAt, created_at: createdAt,
      memory_class: 'episode', trust_state: 'evidence', use_policy: 'can_use_as_evidence',
      author_kind: 'external_client', agent_identity: 'Codex', model_runtime: null, confidence: null,
      retention: 'standard', provenance_note: null, memory_type: null, dedup_hash: null,
      salience_tier: null, governance_downgraded_json: null,
    },
    artifacts,
    document: {
      id: documentId, tenant_id: TENANT, capture_id: captureId, artifact_id: primaryId,
      title: 'Contract', body_r2_key: `canonical/tenant/documents/${documentId}.enc`,
      body_sha256: 'a'.repeat(64), chunk_count: 1, created_at: createdAt,
    },
    chunks: [],
    operation: {
      id: crypto.randomUUID(), tenant_id: TENANT, capture_id: captureId,
      operation_type: 'capture.accepted', status: 'accepted', created_at: createdAt, updated_at: createdAt,
    },
    projectionJobs: [],
    event: null,
  }
}

describe('12.20 canonical artifact manifest structural contract', () => {
  it('rejects a derivative-only manifest at the canonical write layer', async () => {
    const { sql } = stubSql()
    const store = new PostgresCanonicalMemoryStore(sql)
    const derivativeId = crypto.randomUUID()
    const write = captureWrite(
      [{ id: derivativeId, role: 'derivative', parent_artifact_id: derivativeId, ordinal: 0 }],
      derivativeId,
    )
    await expect(store.writeCapture(write)).rejects.toThrow('exactly one source')
  })

  it('rejects a derivative-primary manifest at the canonical write layer', async () => {
    const { sql } = stubSql()
    const store = new PostgresCanonicalMemoryStore(sql)
    const sourceId = crypto.randomUUID()
    const derivativeId = crypto.randomUUID()
    const write = captureWrite([
      { id: sourceId, role: 'source', parent_artifact_id: null, ordinal: 0 },
      { id: derivativeId, role: 'derivative', parent_artifact_id: sourceId, ordinal: 1 },
    ], derivativeId)
    await expect(store.writeCapture(write)).rejects.toThrow('primary artifact must be the source')
  })

  it('rejects a parentless derivative and an out-of-order source', async () => {
    const { sql } = stubSql()
    const store = new PostgresCanonicalMemoryStore(sql)
    const sourceId = crypto.randomUUID()
    const derivativeId = crypto.randomUUID()
    await expect(store.writeCapture(captureWrite([
      { id: sourceId, role: 'source', parent_artifact_id: null, ordinal: 0 },
      { id: derivativeId, role: 'derivative', parent_artifact_id: null, ordinal: 1 },
    ], sourceId))).rejects.toThrow('requires a parent')
    // A source that is not first is caught either as a misplaced source or,
    // when a derivative precedes it, as a forward parent reference.
    await expect(store.writeCapture(captureWrite([
      { id: derivativeId, role: 'derivative', parent_artifact_id: sourceId, ordinal: 0 },
      { id: sourceId, role: 'source', parent_artifact_id: null, ordinal: 1 },
    ], sourceId))).rejects.toThrow('parent must precede')
  })

  it('accepts a valid source-first lineage and artifact-less captures', async () => {
    const { sql, transactions } = stubSql()
    const store = new PostgresCanonicalMemoryStore(sql)
    const sourceId = crypto.randomUUID()
    const firstDerivative = crypto.randomUUID()
    const secondDerivative = crypto.randomUUID()
    await store.writeCapture(captureWrite([
      { id: sourceId, role: 'source', parent_artifact_id: null, ordinal: 0 },
      { id: firstDerivative, role: 'derivative', parent_artifact_id: sourceId, ordinal: 1 },
      { id: secondDerivative, role: 'derivative', parent_artifact_id: firstDerivative, ordinal: 2 },
    ], sourceId))
    await store.writeCapture(captureWrite([], null))
    expect(transactions()).toBe(2)
  })

  it('normalization rejects derivative-only, forward-parent, and derivative-primary manifests', () => {
    const derivative = { artifactId: crypto.randomUUID(), role: 'derivative' as const, primary: true }
    expect(() => toNormalizedArtifacts({ artifactRefs: [
      { ...derivative, parentArtifactId: derivative.artifactId },
    ] })).toThrow('exactly one source')
    const sourceId = crypto.randomUUID()
    const childId = crypto.randomUUID()
    expect(() => toNormalizedArtifacts({ artifactRefs: [
      { artifactId: sourceId, role: 'source', primary: true },
      { artifactId: childId, role: 'derivative', primary: false },
    ] })).toThrow('requires a parent')
    expect(() => toNormalizedArtifacts({ artifactRefs: [
      { artifactId: sourceId, role: 'source', primary: false },
      { artifactId: childId, role: 'derivative', parentArtifactId: sourceId, primary: true },
    ] })).toThrow('primary artifact must be the source')
    expect(() => toNormalizedArtifacts({ artifactRefs: [
      { artifactId: childId, role: 'derivative', parentArtifactId: sourceId, primary: false },
      { artifactId: sourceId, role: 'source', primary: true },
    ] })).toThrow('parent must precede')
  })

  it('normalization accepts a valid lineage and artifact-less captures', () => {
    const sourceId = crypto.randomUUID()
    const childId = crypto.randomUUID()
    const plans = toNormalizedArtifacts({ artifactRefs: [
      { artifactId: sourceId, role: 'source', primary: true },
      { artifactId: childId, role: 'derivative', parentArtifactId: sourceId, primary: false },
    ] })
    expect(plans.map(plan => [plan.role, plan.parentArtifactId, plan.primary])).toEqual([
      ['source', null, true],
      ['derivative', sourceId, false],
    ])
    expect(toNormalizedArtifacts({})).toEqual([])
  })
})
