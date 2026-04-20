import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { decryptCanonicalPayload } from '../src/services/canonical-memory-read-model'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalBrokerTraceDetail } from '../src/types/canonical-memory-broker'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv, type HindsightRecallRow } from './support/hindsight-test-env'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }
type SeededCapture = { operationId: string; engineDocumentId: string }
type BrokerTraceRow = {
  id: string
  tenant_id: string
  primary_mode: string
  shadow_mode: string | null
  primary_status: string
  shadow_status: string
  overlap: string
  detail_r2_key: string | null
}

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-broker-98-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`broker-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('broker-salt'),
    info: new TextEncoder().encode('broker-info'),
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
  recallResults: HindsightRecallRow[]
  recallDelayMs?: number
}): typeof env {
  const { testEnv } = createGraphitiContainerTestEnv()
  const runtime = {
    ...createHindsightTestEnv({
      recallResults: args.recallResults,
      operationStatus: 'completed',
    }),
    GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: testEnv.GRAPHITI,
  } as typeof env
  if (args.recallDelayMs) {
    const baseFetch = runtime.HINDSIGHT.fetch
    runtime.HINDSIGHT.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
      if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(url.pathname)) {
        await new Promise((resolve) => setTimeout(resolve, args.recallDelayMs))
      }
      return baseFetch(input, init)
    }
  }
  return runtime
}

function createToolRegistry(testEnv: typeof env, tmk: CryptoKey | null): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = { tool(name: string, _description: string, _shape: object, handler: ToolHandler) { handlers.set(name, handler) } } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => TENANT_ID,
    getTmk: () => tmk,
    getExecutionContext: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }),
  })
  return { handlers, pending }
}

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

async function captureAndProject(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  testEnv: typeof env,
  tmk: CryptoKey,
): Promise<SeededCapture> {
  const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(fixture, suffix, tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: 'semantic',
    compatibilityMode: 'current_hindsight',
  }, testEnv, TENANT_ID)
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  const pending: Promise<unknown>[] = []
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, testEnv, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  })
  await Promise.allSettled(pending)
  sendSpy.mockRestore()
  const projection = await testEnv.D1_US.prepare(
    `SELECT r.engine_document_id
     FROM canonical_projection_results r
     INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
     WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC LIMIT 1`,
  ).bind(TENANT_ID, result.capture.operationId).first<{ engine_document_id: string }>()
  return {
    operationId: result.capture.operationId,
    engineDocumentId: projection!.engine_document_id,
  }
}

async function readBrokerTrace(
  queryId: string,
  testEnv: typeof env,
  tmk: CryptoKey,
): Promise<{ row: BrokerTraceRow; detail: CanonicalBrokerTraceDetail }> {
  const row = await testEnv.D1_US.prepare(
    `SELECT id, tenant_id, primary_mode, shadow_mode, primary_status, shadow_status, overlap, detail_r2_key
     FROM canonical_broker_traces WHERE tenant_id = ? AND id = ?`,
  ).bind(TENANT_ID, queryId).first<BrokerTraceRow>()
  expect(row).toBeTruthy()
  expect(row?.detail_r2_key).toBeTruthy()
  const object = await testEnv.R2_OBSERVABILITY.get(row!.detail_r2_key!)
  expect(object).toBeTruthy()
  return {
    row: row!,
    detail: JSON.parse(await decryptCanonicalPayload(await object!.text(), tmk)) as CanonicalBrokerTraceDetail,
  }
}

beforeAll(async () => { await ensureTenantWithKek() })
beforeEach(() => { vi.restoreAllMocks() })

describe('9.8 broker primary + shadow retrieval', () => {
  it('keeps semantic as primary, shadows graph, and persists a tenant-scoped broker trace', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject(conversationFixture as CanonicalPipelineCaptureInput, 'semantic-primary', testEnv, tmk)
    recallResults.splice(0, recallResults.length, {
      id: 'semantic-primary-result',
      document_id: seeded.engineDocumentId,
      text: 'User still needs an owner for the operations checklist before the next meeting.',
      score: 0.96,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    const trace = await readBrokerTrace(result.broker!.queryId, testEnv, tmk)

    expect(result.mode).toBe('semantic')
    expect(result.broker?.primaryMode).toBe('semantic')
    expect(result.broker?.shadowMode).toBe('graph')
    expect(result.items[0]?.graphContext).toBeUndefined()
    expect(trace.row.primary_mode).toBe('semantic')
    expect(trace.row.shadow_mode).toBe('graph')
    expect(trace.detail.primary.summary).toContain('operations checklist')
    expect(trace.detail.shadow.summary).toContain('User')
    expect(trace.detail.shadow.projectionKind).toBe('graphiti')
  })

  it('keeps graph as primary, shadows semantic, and records both branches without synthesis', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject(conversationFixture as CanonicalPipelineCaptureInput, 'graph-primary', testEnv, tmk)
    recallResults.splice(0, recallResults.length, {
      id: 'graph-shadow-semantic-result',
      document_id: seeded.engineDocumentId,
      text: 'User has an unresolved operations checklist owner before the next meeting.',
      score: 0.91,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })
    const trace = await readBrokerTrace(result.broker!.queryId, testEnv, tmk)

    expect(result.mode).toBe('graph')
    expect(result.items[0]?.graphContext?.entityLabel).toBe('User')
    expect(result.items[0]?.recallText).toBeUndefined()
    expect(trace.row.primary_mode).toBe('graph')
    expect(trace.row.shadow_mode).toBe('semantic')
    expect(trace.detail.primary.projectionKind).toBe('graphiti')
    expect(trace.detail.shadow.projectionKind).toBe('hindsight')
    expect(trace.detail.surfaced.mode).toBe('graph')
  })

  it('does not block the hot path while a shadow semantic retrieval is slow', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults, recallDelayMs: 250 })
    const seeded = await captureAndProject(conversationFixture as CanonicalPipelineCaptureInput, 'non-blocking', testEnv, tmk)
    recallResults.splice(0, recallResults.length, {
      id: 'non-blocking-shadow-result',
      document_id: seeded.engineDocumentId,
      text: 'Delayed semantic shadow result for the broker.',
      score: 0.75,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })
    const registry = createToolRegistry(testEnv, tmk)
    const handler = registry.handlers.get('search_memory')!

    const startedAt = Date.now()
    const response = await handler({
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })
    const elapsedMs = Date.now() - startedAt
    const result = JSON.parse(response.content[0]?.text ?? 'null') as CanonicalSearchResult
    await Promise.allSettled(registry.pending.splice(0))

    expect(result.mode).toBe('graph')
    expect(elapsedMs).toBeLessThan(200)
  })

  it('keeps the user-facing response primary-only even when the shadow branch diverges', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject(conversationFixture as CanonicalPipelineCaptureInput, 'no-synthesis', testEnv, tmk)
    recallResults.splice(0, recallResults.length, {
      id: 'no-synthesis-semantic-result',
      document_id: seeded.engineDocumentId,
      text: 'Semantic memory says the checklist owner is unresolved.',
      score: 0.98,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    const trace = await readBrokerTrace(result.broker!.queryId, testEnv, tmk)

    expect(result.mode).toBe('semantic')
    expect(result.items.every((item) => item.mode === 'semantic')).toBe(true)
    expect(result.items.every((item) => !item.graphContext)).toBe(true)
    expect(trace.detail.primary.summary).not.toBe(trace.detail.shadow.summary)
    expect(['distinct', 'partial', 'unknown']).toContain(trace.row.overlap)
  })
})
