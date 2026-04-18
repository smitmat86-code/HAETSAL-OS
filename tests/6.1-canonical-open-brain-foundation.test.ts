import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { captureCanonicalMemory, maybeShadowWriteCanonicalCapture } from '../src/services/canonical-memory'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalCaptureInput } from '../src/types/canonical-memory'
import noteFixture from './fixtures/canonical-memory/note-capture.json'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import artifactFixture from './fixtures/canonical-memory/artifact-capture.json'

beforeAll(async () => {
  const now = Date.now()
  for (const tenantId of ['test-tenant-canonical', 'test-tenant-canonical-b']) {
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO tenants
       (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  }
})

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('canonical-memory-test-key-material'),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-memory-test-salt'),
      info: new TextEncoder().encode('canonical-memory-test-info'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptFixture(
  fixture: CanonicalCaptureInput,
  tmk: CryptoKey,
): Promise<CanonicalCaptureInput> {
  return {
    ...fixture,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
    artifactRef: fixture.artifactRef
      ? {
        ...fixture.artifactRef,
        contentEncrypted: await encryptContentForArchive('artifact payload for canonical capture fixture', tmk),
      }
      : null,
  }
}

describe('6.1 canonical open-brain foundation', () => {
  it('persists a note capture with document, chunks, operation, projection jobs, and audit rows', async () => {
    const input = await encryptFixture(noteFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const capture = await env.D1_US.prepare(
      `SELECT source_system, scope, body_r2_key FROM canonical_captures WHERE id = ?`,
    ).bind(result.captureId).first<{ source_system: string; scope: string; body_r2_key: string }>()
    const document = await env.D1_US.prepare(
      `SELECT chunk_count FROM canonical_documents WHERE id = ?`,
    ).bind(result.documentId).first<{ chunk_count: number }>()
    const projections = await env.D1_US.prepare(
      `SELECT projection_kind FROM canonical_projection_jobs WHERE operation_id = ? ORDER BY projection_kind`,
    ).bind(result.operationId).all<{ projection_kind: string }>()
    const audit = await env.D1_US.prepare(
      `SELECT operation FROM memory_audit WHERE tenant_id = ? AND memory_id IN (?, ?)`,
    ).bind(input.tenantId, result.captureId, result.operationId).all<{ operation: string }>()

    expect(result.captureId).toBeDefined()
    expect(result.chunkIds.length).toBeGreaterThan(0)
    expect(capture).not.toBeNull()
    expect(capture!.source_system).toBe('mcp_retain')
    expect(capture!.scope).toBe('general')
    expect(document!.chunk_count).toBe(result.chunkIds.length)
    expect(projections.results.map(row => row.projection_kind)).toEqual(['graphiti', 'hindsight'])
    expect(audit.results.map(row => row.operation)).toEqual(expect.arrayContaining([
      'memory.capture.accepted',
      'memory.projection.enqueued',
    ]))
  })

  it('creates multiple chunks for conversation-style captures', async () => {
    const input = await encryptFixture(conversationFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const chunks = await env.D1_US.prepare(
      `SELECT ordinal, start_offset, end_offset FROM canonical_chunks WHERE document_id = ? ORDER BY ordinal`,
    ).bind(result.documentId).all<{ ordinal: number; start_offset: number; end_offset: number }>()

    expect(result.chunkIds.length).toBeGreaterThan(1)
    expect(chunks.results[0]?.ordinal).toBe(0)
    expect(chunks.results.at(-1)!.end_offset).toBeGreaterThan(chunks.results[0]!.start_offset)
  })

  it('links artifact-backed captures to canonical artifact metadata', async () => {
    const input = await encryptFixture(artifactFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const document = await env.D1_US.prepare(
      `SELECT artifact_id FROM canonical_documents WHERE id = ?`,
    ).bind(result.documentId).first<{ artifact_id: string }>()
    const artifact = await env.D1_US.prepare(
      `SELECT filename, media_type, r2_key FROM canonical_artifacts WHERE id = ?`,
    ).bind(document!.artifact_id).first<{ filename: string; media_type: string; r2_key: string }>()

    expect(document!.artifact_id).toBeTruthy()
    expect(artifact!.filename).toBe('brief.txt')
    expect(artifact!.media_type).toBe('text/plain')
    expect(artifact!.r2_key).toContain('canonical/test-tenant-canonical/artifacts/')
  })

  it('keeps HAETSAL-owned content encrypted and tenant-scoped', async () => {
    const input = await encryptFixture(noteFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const stored = await env.R2_ARTIFACTS.get((await env.D1_US.prepare(
      `SELECT body_r2_key FROM canonical_documents WHERE id = ?`,
    ).bind(result.documentId).first<{ body_r2_key: string }>())!.body_r2_key)
    const foreignTenantView = await env.D1_US.prepare(
      `SELECT id FROM canonical_captures WHERE tenant_id = ? AND id = ?`,
    ).bind('test-tenant-canonical-b', result.captureId).first()
    const storedBody = await stored!.text()

    expect(storedBody).toBe(input.bodyEncrypted)
    expect(storedBody).not.toContain(input.body)
    expect(foreignTenantView).toBeNull()
  })

  it('supports an off-by-default shadow-write hook without touching the retain contract', async () => {
    const fixture = await encryptFixture(noteFixture as CanonicalCaptureInput, await deriveTestTmk())
    const shadowEnv = { ...env, CANONICAL_MEMORY_SHADOW_WRITES: 'true' }
    await maybeShadowWriteCanonicalCapture({
      tenantId: fixture.tenantId,
      sourceSystem: fixture.sourceSystem,
      sourceRef: fixture.sourceRef,
      scope: fixture.scope,
      title: fixture.title,
      body: fixture.body,
      bodyEncrypted: fixture.bodyEncrypted,
    }, shadowEnv)
    const shadowed = await env.D1_US.prepare(
      `SELECT projection_kind FROM canonical_projection_jobs WHERE tenant_id = ? AND projection_kind IN ('hindsight', 'graphiti')`,
    ).bind(fixture.tenantId).all<{ projection_kind: string }>()

    expect(shadowed.results.map(row => row.projection_kind)).toEqual(expect.arrayContaining(['hindsight', 'graphiti']))
  })
})
