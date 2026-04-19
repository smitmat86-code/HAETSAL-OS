import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { retainContent } from '../src/services/ingestion/retain'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { IngestionArtifact } from '../src/types/ingestion'
import artifactFixture from './fixtures/canonical-memory/artifact-capture.json'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-canonical-63-${SUITE_ID}`
const TENANT_B = `test-tenant-canonical-63-b-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-pipeline-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-pipeline-salt'),
      info: new TextEncoder().encode('canonical-pipeline-info'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  tenantId: string,
  suffix: string,
): Promise<CanonicalPipelineCaptureInput> {
  const tmk = await deriveTestTmk()
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
    artifactRef: fixture.artifactRef
      ? {
        ...fixture.artifactRef,
        contentEncrypted: await encryptContentForArchive(`artifact-${suffix}`, tmk),
      }
      : null,
  }
}

function makeEnvWithHindsightStub() {
  return {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname) || /^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as { async?: boolean }
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: body.async ?? false,
            operation_id: body.async ? `op-${crypto.randomUUID()}` : undefined,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    },
  } as unknown as typeof env
}

beforeAll(async () => {
  await Promise.all([ensureTenant(TENANT_A), ensureTenant(TENANT_B)])
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('6.3 canonical capture pipeline', () => {
  it('makes live note capture canonical-first, queues projection handoff, and records compatibility state', async () => {
    const testEnv = makeEnvWithHindsightStub()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, TENANT_A, 'note')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
      salienceTier: 3,
      salienceSurpriseScore: 0.9,
      hindsightAsync: true,
    }, testEnv, TENANT_A)

    const queued = await testEnv.D1_US.prepare(
      `SELECT status FROM canonical_memory_operations WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT_A, result.capture.operationId).first<{ status: string }>()
    const message = sendSpy.mock.calls[0]?.[0]
    const status = await getCanonicalMemoryStatus({ tenantId: TENANT_A, operationId: result.capture.operationId }, testEnv, TENANT_A)

    expect(result.dispatch.status).toBe('queued')
    expect(result.compatibility.status).toBe('queued')
    expect(queued?.status).toBe('queued')
    expect(JSON.stringify(message)).not.toContain(input.body)
    expect(JSON.stringify(message)).not.toContain(input.bodyEncrypted!)
    expect(status.projections.map(item => item.kind)).toEqual(expect.arrayContaining(['hindsight', 'graphiti']))
    expect(status.compatibility?.status).toBe('queued')
  })

  it('keeps conversation captures canonical-first even when compatibility is off', async () => {
    const testEnv = makeEnvWithHindsightStub()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, TENANT_A, 'conversation')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      compatibilityMode: 'off',
      memoryType: 'semantic',
    }, testEnv, TENANT_A)

    const chunks = await testEnv.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM canonical_chunks WHERE document_id = ?`,
    ).bind(result.capture.documentId).first<{ count: number }>()
    const message = sendSpy.mock.calls[0]?.[0] as { payload: { projectionKinds: string[] } }

    expect(result.capture.chunkIds.length).toBeGreaterThan(1)
    expect(chunks?.count).toBe(result.capture.chunkIds.length)
    expect(result.compatibility.status).toBe('skipped')
    expect(message.payload.projectionKinds).toEqual(expect.arrayContaining(['hindsight', 'graphiti']))
  })

  it('preserves encrypted artifact handling and keeps queue payloads metadata-only', async () => {
    const testEnv = makeEnvWithHindsightStub()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(artifactFixture as CanonicalPipelineCaptureInput, TENANT_A, 'artifact')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      compatibilityMode: 'off',
      memoryType: 'world',
    }, testEnv, TENANT_A)

    const artifact = await testEnv.D1_US.prepare(
      `SELECT filename, media_type, r2_key FROM canonical_artifacts WHERE capture_id = ?`,
    ).bind(result.capture.captureId).first<{ filename: string; media_type: string; r2_key: string }>()
    const messageJson = JSON.stringify(sendSpy.mock.calls[0]?.[0])

    expect(artifact?.filename).toBe('brief.txt')
    expect(artifact?.media_type).toBe('text/plain')
    expect(artifact?.r2_key).toContain('canonical/')
    expect(messageJson).not.toContain(input.body)
    expect(messageJson).not.toContain('artifact-artifact')
  })

  it('preserves the current Hindsight-visible retain behavior through the compatibility lane', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const artifact: IngestionArtifact = {
      tenantId: TENANT_A,
      source: 'mcp_retain',
      content: `canonical-live-write-${crypto.randomUUID()}`,
      occurredAt: Date.now(),
      memoryType: 'episodic',
      domain: 'general',
      provenance: 'mcp_retain',
    }

    const result = await retainContent(artifact, tmk, testEnv, undefined, { hindsightAsync: true })
    const hindsightOp = await testEnv.D1_US.prepare(
      `SELECT status FROM hindsight_operations WHERE operation_id = ?`,
    ).bind(result!.operationId).first<{ status: string }>()
    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result!.canonicalOperationId },
      testEnv,
      TENANT_A,
    )

    expect(result?.canonicalCaptureId).toBeTruthy()
    expect(result?.canonicalDispatchStatus).toBe('queued')
    expect(result?.compatibilityStatus).toBe('queued')
    expect(hindsightOp?.status).toBe('pending')
    expect(status.compatibility?.targetRef).toContain(result!.operationId!)
  })

  it('still blocks procedural writes before canonical capture is created', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const before = await testEnv.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM canonical_captures WHERE tenant_id = ?`,
    ).bind(TENANT_B).first<{ count: number }>()

    const result = await retainContent({
      tenantId: TENANT_B,
      source: 'mcp_retain',
      content: 'I always avoid conflict and never push back in meetings.',
      occurredAt: Date.now(),
      memoryType: 'procedural' as unknown as 'episodic',
      provenance: 'mcp_retain',
    }, tmk, testEnv)
    const after = await testEnv.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM canonical_captures WHERE tenant_id = ?`,
    ).bind(TENANT_B).first<{ count: number }>()

    expect(result).toBeNull()
    expect(after?.count).toBe(before?.count)
  })
})
