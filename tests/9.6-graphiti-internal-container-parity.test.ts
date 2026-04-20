import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalEntityTimeline, traceCanonicalRelationship } from '../src/services/canonical-graph-query'
import { submitGraphitiProjection } from '../src/services/canonical-graphiti-projection'
import { prepareContextForAgent } from '../src/services/chief-of-staff-context'
import { healthcheckGraphitiRuntime } from '../src/services/graphiti-client'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv, type HindsightCaptureState, type HindsightRecallRow } from './support/hindsight-test-env'

type SeededCapture = { operationId: string; documentId: string; engineDocumentId: string }

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-graphiti-96-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`graphiti-96-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('graphiti-96-salt'),
    info: new TextEncoder().encode('graphiti-96-info'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function ensureTenantWithKek(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()
  await env.KV_SESSION.put(`cron_kek:${TENANT_ID}`, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), { expirationTtl: 60 * 60 * 24 })
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now + (24 * 60 * 60 * 1000), now, TENANT_ID).run()
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId: TENANT_ID,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createRuntimeEnv(args: {
  capture: HindsightCaptureState
  recallResults?: HindsightRecallRow[]
  graphStartFails?: string
}) {
  const { testEnv, requests } = createGraphitiContainerTestEnv({
    startFails: args.graphStartFails,
  })
  return {
    requests,
    testEnv: {
      ...createHindsightTestEnv({
        capture: args.capture,
        operationStatus: 'completed',
        recallResults: args.recallResults ?? [],
      }),
      GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: testEnv.GRAPHITI,
    } as typeof env,
  }
}

async function captureAndDispatch(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  memoryType: 'episodic' | 'semantic' | 'world'
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<SeededCapture> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: args.memoryType,
    compatibilityMode: 'current_hindsight',
  }, args.testEnv, TENANT_ID)
  const pending: Promise<unknown>[] = []
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, args.testEnv, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  })
  await Promise.allSettled(pending)
  sendSpy.mockRestore()
  const projection = await args.testEnv.D1_US.prepare(
    `SELECT r.engine_document_id
     FROM canonical_projection_results r
     INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
     WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC LIMIT 1`,
  ).bind(TENANT_ID, result.capture.operationId).first<{ engine_document_id: string }>()
  return {
    operationId: result.capture.operationId,
    documentId: result.capture.documentId,
    engineDocumentId: projection!.engine_document_id,
  }
}

beforeAll(async () => {
  await ensureTenantWithKek()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('9.6 graphiti internal container parity', () => {
  it('submits graph projection through the internal container path and exposes health/readiness without GRAPHITI_API_URL', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv, requests } = createRuntimeEnv({ capture: { retainCount: 0, operationIds: [] } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const seeded = await captureAndDispatch({
      fixture: noteFixture as CanonicalPipelineCaptureInput,
      suffix: 'internal-path',
      memoryType: 'episodic',
      testEnv,
      tmk,
    })
    const status = await getCanonicalMemoryStatus({ tenantId: TENANT_ID, operationId: seeded.operationId }, testEnv, TENANT_ID)
    const health = await healthcheckGraphitiRuntime(testEnv as never)

    expect((testEnv as typeof env & { GRAPHITI_API_URL?: string }).GRAPHITI_API_URL).toBeUndefined()
    expect(health).toEqual({ status: 'ok', ready: true })
    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.content?.body ?? '')).toContain('productive planning session')
    expect(status.graph?.status).toBe('projected')
    expect(status.graph?.targetRef).toContain('graphiti://episodes/')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails graph jobs truthfully when container mode is required and the runtime is unavailable', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv } = createRuntimeEnv({
      capture: { retainCount: 0, operationIds: [] },
      graphStartFails: 'graphiti container unavailable',
    })
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, 'graphiti-down', tmk)
    const capture = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_ID)
    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
    await processCanonicalProjectionDispatch(message.tenantId, message.payload, testEnv)

    const status = await getCanonicalMemoryStatus({ tenantId: TENANT_ID, operationId: capture.capture.operationId }, testEnv, TENANT_ID)

    expect(status.operation.status).toBe('failed')
    expect(status.graph?.status).toBe('failed')
    expect(status.graph?.errorMessage).toContain('graphiti container unavailable')
  })

  it('keeps fresh graph-backed trace, timeline, and context composition working on the internal runtime path', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const { testEnv } = createRuntimeEnv({
      capture: { retainCount: 0, operationIds: [] },
      recallResults,
    })
    const note = await captureAndDispatch({
      fixture: noteFixture as CanonicalPipelineCaptureInput,
      suffix: 'fresh-note',
      memoryType: 'episodic',
      testEnv,
      tmk,
    })
    const conversation = await captureAndDispatch({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'fresh-conversation',
      memoryType: 'semantic',
      testEnv,
      tmk,
    })
    recallResults.splice(0, recallResults.length, {
      document_id: conversation.engineDocumentId,
      text: 'The operations checklist still needs an owner before the next meeting.',
      score: 0.96,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })

    const relationship = await traceCanonicalRelationship({
      tenantId: TENANT_ID,
      from: 'User',
      to: 'Assistant',
      relation: 'conversed_with',
      limit: 5,
    }, testEnv, TENANT_ID)
    const timeline = await getCanonicalEntityTimeline({
      tenantId: TENANT_ID,
      entity: 'general',
      limit: 5,
      startAt: null,
      endAt: null,
    }, testEnv, TENANT_ID)
    const bundle = await prepareContextForAgent({
      agent: 'chief_of_staff',
      intent: 'person',
      target: 'User',
      limit: 4,
      scope: null,
    }, testEnv, TENANT_ID, { tmk })
    const mappings = await testEnv.D1_US.prepare(
      `SELECT graph_kind FROM canonical_graph_identity_mappings
       WHERE tenant_id = ? ORDER BY graph_kind, canonical_key`,
    ).bind(TENANT_ID).all<{ graph_kind: string }>()

    expect(mappings.results.map((row) => row.graph_kind)).toEqual(expect.arrayContaining(['edge', 'entity', 'episode']))
    expect(relationship.items[0]?.provenance.graphRef).toContain('graphiti://edges/')
    expect(timeline.items.map((item) => item.title)).toEqual(expect.arrayContaining(['Daily note', 'Conversation recap']))
    expect(bundle.relationships[0]).toContain('User')
    expect(bundle.timeline.length).toBeGreaterThan(0)
    expect(bundle.sources.some((source) => source.mode === 'semantic' && source.documentId === conversation.documentId)).toBe(true)
    expect(bundle.evidence.some((block) => block.mode === 'composed' && block.items.length > 0)).toBe(true)
  })

  it('supports direct internal submission for one graph job without the queue shell', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv, requests } = createRuntimeEnv({ capture: { retainCount: 0, operationIds: [] } })
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, 'direct-submit', tmk)
    const capture = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_ID)
    const graphJob = await testEnv.D1_US.prepare(
      `SELECT id FROM canonical_projection_jobs
       WHERE tenant_id = ? AND operation_id = ? AND projection_kind = 'graphiti'`,
    ).bind(TENANT_ID, capture.capture.operationId).first<{ id: string }>()

    const submission = await submitGraphitiProjection({
      tenantId: TENANT_ID,
      captureId: capture.capture.captureId,
      operationId: capture.capture.operationId,
      projectionJobId: graphJob!.id,
      projectionKind: 'graphiti',
    }, testEnv)

    expect(submission?.status).toBe('completed')
    expect(requests[0]?.projectionJobId).toBe(graphJob!.id)
  })
})
