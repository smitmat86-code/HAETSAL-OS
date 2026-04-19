import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import noteFixture from './fixtures/canonical-memory/note-capture.json'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-graphiti-82-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`graphiti-ingestion-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('graphiti-ingestion-salt'),
      info: new TextEncoder().encode('graphiti-ingestion-info'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  await env.KV_SESSION.put(
    `cron_kek:${tenantId}`,
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    { expirationTtl: 60 * 60 * 24 },
  )
  await env.D1_US.prepare(
    `UPDATE tenants
     SET cron_kek_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
): Promise<CanonicalPipelineCaptureInput> {
  const tmk = await deriveTestTmk()
  return {
    ...fixture,
    tenantId: TENANT_A,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function makeGraphitiEnv() {
  return {
    ...env,
    GRAPHITI_API_URL: 'https://graphiti.internal',
    GRAPHITI_API_TOKEN: 'graphiti-test-token',
  } as typeof env
}

function buildCompletedResponse(body: Record<string, any>) {
  return {
    status: 'completed',
    targetRef: `graphiti://episodes/${body.captureId}`,
    episodeRefs: [`graphiti://episodes/${body.captureId}`],
    entityRefs: (body.plan.entities as Array<Record<string, unknown>>).map((_: unknown, index: number) => `graphiti://entities/${body.captureId}-${index}`),
    edgeRefs: (body.plan.edges as Array<Record<string, unknown>>).map((_: unknown, index: number) => `graphiti://edges/${body.captureId}-${index}`),
    mappings: [
      {
        canonicalKey: body.plan.episode.canonicalKey,
        graphRef: `graphiti://episodes/${body.captureId}`,
        graphKind: 'episode',
      },
      ...(body.plan.entities as Array<Record<string, unknown>>).map((entity, index: number) => ({
        canonicalKey: entity.canonicalKey,
        graphRef: `graphiti://entities/${body.captureId}-${index}`,
        graphKind: 'entity',
      })),
      ...(body.plan.edges as Array<Record<string, unknown>>).map((edge, index: number) => ({
        canonicalKey: edge.canonicalKey,
        graphRef: `graphiti://edges/${body.captureId}-${index}`,
        graphKind: 'edge',
      })),
    ],
  }
}

async function processGraphitiDispatch(
  message: { tenantId: string; payload: Record<string, unknown> },
  testEnv: typeof env,
): Promise<void> {
  await processCanonicalProjectionDispatch(message.tenantId, {
    ...message.payload,
    projectionKinds: ['graphiti'],
  }, testEnv)
}

beforeAll(async () => {
  await ensureTenantWithKek(TENANT_A)
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('8.2 graphiti ingestion projection', () => {
  it('projects note captures through the canonical dispatch path and persists graph identity mappings', async () => {
    const requests: Array<Record<string, any>> = []
    const originalFetch = globalThis.fetch
    const testEnv = makeGraphitiEnv()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input)
      if (!url.includes('graphiti.internal')) return originalFetch(input, init)
      const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}'))) as Record<string, any>
      requests.push(body)
      return new Response(JSON.stringify(buildCompletedResponse(body)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, 'note')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      compatibilityMode: 'off',
      memoryType: 'episodic',
    }, testEnv, TENANT_A)
    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
    await processGraphitiDispatch(message, testEnv)

    const mappings = await testEnv.D1_US.prepare(
      `SELECT canonical_key, graph_ref, graph_kind
       FROM canonical_graph_identity_mappings
       WHERE tenant_id = ?
       ORDER BY graph_kind ASC, canonical_key ASC`,
    ).bind(TENANT_A).all<{ canonical_key: string; graph_ref: string; graph_kind: string }>()
    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )

    expect(JSON.stringify(message)).not.toContain(input.body)
    expect(JSON.stringify(message)).not.toContain(input.bodyEncrypted!)
    expect(requests[0]?.plan.episode.kind).toBe('note')
    expect(requests[0]?.content.body).toBe(input.body)
    expect(mappings.results.map((row) => row.graph_kind)).toEqual(expect.arrayContaining(['edge', 'entity', 'episode']))
    expect(status.graph?.status).toBe('projected')
    expect(status.graph?.ready).toBe(true)
    expect(status.graph?.targetRef).toContain('graphiti://episodes/')
  })

  it('projects conversation captures into conversation episodes, speaker entities, and temporal edges', async () => {
    const requests: Array<Record<string, any>> = []
    const originalFetch = globalThis.fetch
    const testEnv = makeGraphitiEnv()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input)
      if (!url.includes('graphiti.internal')) return originalFetch(input, init)
      const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}'))) as Record<string, any>
      requests.push(body)
      return new Response(JSON.stringify(buildCompletedResponse(body)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, 'conversation')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      compatibilityMode: 'off',
      memoryType: 'semantic',
    }, testEnv, TENANT_A)
    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
    await processGraphitiDispatch(message, testEnv)

    const graphProjection = requests[0]?.plan as { episode: { kind: string }; entities: Array<{ canonicalKey: string }>; edges: Array<{ relation: string }> }
    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )

    expect(graphProjection.episode.kind).toBe('conversation')
    expect(graphProjection.entities.map((entity) => entity.canonicalKey)).toEqual(expect.arrayContaining([
      'canonical://participants/user',
      'canonical://participants/assistant',
    ]))
    expect(graphProjection.edges.map((edge) => edge.relation)).toEqual(expect.arrayContaining([
      'has_participant',
      'conversed_with',
    ]))
    expect(status.graph?.status).toBe('projected')
  })

  it('marks graph projection failures truthfully and allows a later retry to complete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempt = 0
    const originalFetch = globalThis.fetch
    const testEnv = makeGraphitiEnv()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input)
      if (!url.includes('graphiti.internal')) return originalFetch(input, init)
      const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}'))) as Record<string, any>
      attempt += 1
      if (attempt === 1) {
        return new Response(JSON.stringify({ detail: 'graphiti runtime unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(buildCompletedResponse(body)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, 'retry')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      compatibilityMode: 'off',
      memoryType: 'episodic',
    }, testEnv, TENANT_A)
    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }

    await processGraphitiDispatch(message, testEnv)
    const failedStatus = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )
    await processGraphitiDispatch(message, testEnv)
    const recoveredStatus = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )

    expect(failedStatus.graph?.status).toBe('failed')
    expect(failedStatus.graph?.errorMessage).toContain('503')
    expect(recoveredStatus.graph?.status).toBe('projected')
    expect(recoveredStatus.graph?.targetRef).toContain('graphiti://episodes/')
  })
})
