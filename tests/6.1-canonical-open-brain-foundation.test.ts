import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { captureCanonicalMemory, maybeShadowWriteCanonicalCapture } from '../src/services/canonical-memory'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
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
    const store = getCanonicalMemoryStore(env)
    const capture = await store.getCapture(input.tenantId, result.captureId)
    const document = await store.getDocument(input.tenantId, result.documentId)
    const projections = await store.listProjectionJobsForOperation(input.tenantId, result.operationId)
    const audit = await env.D1_US.prepare(
      `SELECT operation FROM memory_audit WHERE tenant_id = ? AND memory_id IN (?, ?)`,
    ).bind(input.tenantId, result.captureId, result.operationId).all<{ operation: string }>()

    expect(result.captureId).toBeDefined()
    expect(result.chunkIds.length).toBeGreaterThan(0)
    expect(capture).not.toBeNull()
    expect(capture!.source_system).toBe('mcp_retain')
    expect(capture!.scope).toBe('general')
    expect(document!.chunk_count).toBe(result.chunkIds.length)
    expect(projections).toHaveLength(0)
    expect(audit.results.map(row => row.operation)).toEqual(['memory.capture.accepted'])
  })

  it('creates multiple chunks for conversation-style captures', async () => {
    const input = await encryptFixture(conversationFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const document = await getCanonicalMemoryStore(env).getDocument(input.tenantId, result.documentId)

    expect(result.chunkIds.length).toBeGreaterThan(1)
    expect(document?.chunk_count).toBe(result.chunkIds.length)
  })

  it('links artifact-backed captures to canonical artifact metadata', async () => {
    const input = await encryptFixture(artifactFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const document = await getCanonicalMemoryStore(env).getDocument(input.tenantId, result.documentId)

    expect(document!.artifact_id).toBeTruthy()
    expect(document!.filename).toBe('brief.txt')
    expect(document!.media_type).toBe('text/plain')
    expect(document!.r2_key).toContain('canonical/test-tenant-canonical/artifacts/')
  })

  it('keeps HAETSAL-owned content encrypted and tenant-scoped', async () => {
    const input = await encryptFixture(noteFixture as CanonicalCaptureInput, await deriveTestTmk())
    const result = await captureCanonicalMemory(input, env, input.tenantId)
    const store = getCanonicalMemoryStore(env)
    const bodyR2Key = (await store.getDocument(input.tenantId, result.documentId))!.body_r2_key
    const stored = await env.R2_ARTIFACTS.get(bodyR2Key)
    const foreignTenantView = await store.getCapture('test-tenant-canonical-b', result.captureId)
    const storedBody = await stored!.text()

    expect(storedBody).toBe(input.bodyEncrypted)
    expect(storedBody).not.toContain(input.body)
    expect(foreignTenantView).toBeNull()
  })

  it('supports an off-by-default shadow-write hook without touching the retain contract', async () => {
    const fixture = await encryptFixture(noteFixture as CanonicalCaptureInput, await deriveTestTmk())
    const shadowEnv = { ...env, CANONICAL_MEMORY_SHADOW_WRITES: 'true' }
    const store = getCanonicalMemoryStore(env)
    const before = await store.getStats(fixture.tenantId)
    await maybeShadowWriteCanonicalCapture({
      tenantId: fixture.tenantId,
      sourceSystem: fixture.sourceSystem,
      sourceRef: fixture.sourceRef,
      scope: fixture.scope,
      title: fixture.title,
      body: fixture.body,
      bodyEncrypted: fixture.bodyEncrypted,
    }, shadowEnv)
    const after = await store.getStats(fixture.tenantId)

    expect(after.captureCount).toBe(before.captureCount + 1)
    expect(after.pendingProjectionCount).toBe(before.pendingProjectionCount)
  })
})
