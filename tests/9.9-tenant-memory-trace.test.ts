import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type {
  CanonicalBrokerTraceListResult,
  CanonicalBrokerTraceView,
} from '../src/types/canonical-memory-broker'
import type { PrepareContextForAgentInput } from '../src/types/chief-of-staff-context'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv, type HindsightRecallRow } from './support/hindsight-test-env'
import { seedHistoricalHindsightProjection } from './support/historical-hindsight-seed'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }
type SeededCapture = { operationId: string; engineDocumentId: string }
type BrokerTraceRow = { detail_r2_key: string | null }

function uniqueTenantId(label: string): string {
  return `test-tenant-broker-99-${label}-${crypto.randomUUID()}`
}

async function deriveTestTmk(seed: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`broker-99-${seed}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('broker-99-salt'),
      info: new TextEncoder().encode('broker-99-info'),
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
    `UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  tenantId: string,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createRuntimeEnv(args: {
  recallResults: HindsightRecallRow[]
}): typeof env {
  const { testEnv } = createGraphitiContainerTestEnv()
  return {
    ...createHindsightTestEnv({
      recallResults: args.recallResults,
      operationStatus: 'completed',
    }),
    GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: testEnv.GRAPHITI,
  } as typeof env
}

function createToolRegistry(
  testEnv: typeof env,
  tenantId: string,
  tmk: CryptoKey | null,
): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = {
    tool(name: string, _description: string, _shape: object, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => tenantId,
    getTmk: () => tmk,
    getExecutionContext: () => ({
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    }),
  })
  return { handlers, pending }
}

async function callTool<T>(
  registry: ToolRegistry,
  name: string,
  input: unknown,
): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

async function captureAndProject(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  tenantId: string
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<SeededCapture> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, args.tenantId, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: 'semantic',
  }, args.testEnv, args.tenantId)
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  const pending: Promise<unknown>[] = []
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, args.testEnv, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  })
  await Promise.allSettled(pending)
  sendSpy.mockRestore()
  // Historical Hindsight projection: simulates a capture that was projected
  // to Hindsight before the write path was severed (mission Phase 1). The
  // pipeline can no longer produce these, so this is seeded directly for the
  // same body/scope/title as the real (graphiti) capture above.
  const seeded = await seedHistoricalHindsightProjection(args.testEnv, {
    tenantId: args.tenantId,
    sourceSystem: args.fixture.sourceSystem,
    sourceRef: args.fixture.sourceRef ? `${args.fixture.sourceRef}-${args.suffix}` : null,
    scope: args.fixture.scope,
    title: args.fixture.title ?? null,
    body: args.fixture.body,
    capturedAt: args.fixture.capturedAt ?? null,
    tmk: args.tmk,
  })
  return {
    operationId: result.capture.operationId,
    engineDocumentId: seeded.engineDocumentId,
  }
}

async function readBrokerTraceRow(
  testEnv: typeof env,
  tenantId: string,
  queryId: string,
): Promise<BrokerTraceRow> {
  const row = await testEnv.D1_US.prepare(
    `SELECT detail_r2_key
     FROM canonical_broker_traces
     WHERE tenant_id = ? AND id = ?`,
  ).bind(tenantId, queryId).first<BrokerTraceRow>()
  expect(row).toBeTruthy()
  return row!
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('9.9 tenant memory trace', () => {
  it('lists recent traces for the tenant in recency order and supports primary-mode filtering', async () => {
    const tenantId = uniqueTenantId('recent')
    const tmk = await deriveTestTmk(tenantId)
    await ensureTenantWithKek(tenantId)
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'recent',
      tenantId,
      testEnv,
      tmk,
    })
    recallResults.splice(0, recallResults.length, {
      id: 'recent-semantic',
      document_id: seeded.engineDocumentId,
      text: 'User still needs an owner for the operations checklist before the next meeting.',
      score: 0.96,
      tags: [`tenant:${tenantId}`],
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })
    const registry = createToolRegistry(testEnv, tenantId, tmk)
    const semantic = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const graph = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })

    const traces = await callTool<CanonicalBrokerTraceListResult>(registry, 'get_recent_memory_traces', { limit: 10 })
    const semanticOnly = await callTool<CanonicalBrokerTraceListResult>(registry, 'get_recent_memory_traces', {
      limit: 10,
      mode: 'semantic',
    })

    expect(traces.items.slice(0, 2).map((item) => item.queryId)).toEqual([
      graph.broker!.queryId,
      semantic.broker!.queryId,
    ])
    expect(traces.items[0]?.primaryMode).toBe('graph')
    expect(traces.items[0]?.detailStatus).toBe('ok')
    expect(traces.items[0]?.surfacedSummary).toContain('User')
    expect(traces.items[1]?.primaryMode).toBe('semantic')
    expect(traces.items[1]?.surfacedSummary).toContain('operations checklist')
    expect(semanticOnly.items.map((item) => item.queryId)).toEqual([semantic.broker!.queryId])
  })

  it('hydrates full detail for semantic-primary and graph-primary broker queries', async () => {
    const tenantId = uniqueTenantId('hydrate')
    const tmk = await deriveTestTmk(tenantId)
    await ensureTenantWithKek(tenantId)
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'hydrate',
      tenantId,
      testEnv,
      tmk,
    })
    recallResults.splice(0, recallResults.length, {
      id: 'hydrate-semantic',
      document_id: seeded.engineDocumentId,
      text: 'User still needs an owner for the operations checklist before the next meeting.',
      score: 0.95,
      tags: [`tenant:${tenantId}`],
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })
    const registry = createToolRegistry(testEnv, tenantId, tmk)
    const semantic = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    const graph = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })

    const semanticTrace = await callTool<CanonicalBrokerTraceView>(registry, 'get_memory_trace', {
      query_id: semantic.broker!.queryId,
    })
    const graphTrace = await callTool<CanonicalBrokerTraceView>(registry, 'get_memory_trace', {
      query_id: graph.broker!.queryId,
    })

    expect(semanticTrace.detailStatus).toBe('ok')
    expect(semanticTrace.queryText).toBe('What do I know about User?')
    expect(semanticTrace.route.mode).toBe('semantic')
    expect(semanticTrace.route.dispatchQuery).toBe('What do I know about User')
    expect(semanticTrace.primary.summary).toContain('operations checklist')
    expect(semanticTrace.shadow.mode).toBe('graph')
    expect(semanticTrace.surfaced.summary).toContain('operations checklist')

    expect(graphTrace.detailStatus).toBe('ok')
    expect(graphTrace.queryText).toBe('How has my relationship with User changed over time?')
    expect(graphTrace.route.mode).toBe('graph')
    expect(graphTrace.primary.projectionKind).toBe('graphiti')
    expect(graphTrace.shadow.mode).toBe('semantic')
    expect(graphTrace.shadow.projectionKind).toBe('hindsight')
    expect(graphTrace.primary.summary).toContain('User')
  })

  it('degrades gracefully when the rich detail blob is missing', async () => {
    const tenantId = uniqueTenantId('missing')
    const tmk = await deriveTestTmk(tenantId)
    await ensureTenantWithKek(tenantId)
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'missing',
      tenantId,
      testEnv,
      tmk,
    })
    recallResults.splice(0, recallResults.length, {
      id: 'missing-semantic',
      document_id: seeded.engineDocumentId,
      text: 'User still needs an owner for the operations checklist before the next meeting.',
      score: 0.95,
      tags: [`tenant:${tenantId}`],
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })
    const registry = createToolRegistry(testEnv, tenantId, tmk)
    const semantic = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    const row = await readBrokerTraceRow(testEnv, tenantId, semantic.broker!.queryId)
    await testEnv.R2_OBSERVABILITY.delete(row.detail_r2_key!)

    const trace = await callTool<CanonicalBrokerTraceView>(registry, 'get_memory_trace', {
      query_id: semantic.broker!.queryId,
    })
    const traces = await callTool<CanonicalBrokerTraceListResult>(registry, 'get_recent_memory_traces', { limit: 5 })

    expect(trace.detailStatus).toBe('missing')
    expect(trace.queryText).toBeNull()
    expect(trace.route.mode).toBe('semantic')
    expect(trace.route.reason).toBeTruthy()
    expect(trace.surfaced.summary).toBeNull()
    expect(trace.primary.status).toBe('ok')
    expect(traces.items[0]?.detailStatus).toBe('missing')
    expect(traces.items[0]?.surfacedSummary).toBeNull()
  })

  it('rejects cross-tenant trace access', async () => {
    const tenantA = uniqueTenantId('tenant-a')
    const tenantB = uniqueTenantId('tenant-b')
    const tmkA = await deriveTestTmk(tenantA)
    const tmkB = await deriveTestTmk(tenantB)
    await Promise.all([ensureTenantWithKek(tenantA), ensureTenantWithKek(tenantB)])
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'cross-tenant',
      tenantId: tenantA,
      testEnv,
      tmk: tmkA,
    })
    recallResults.splice(0, recallResults.length, {
      id: 'cross-tenant-semantic',
      document_id: seeded.engineDocumentId,
      text: 'User still needs an owner for the operations checklist before the next meeting.',
      score: 0.95,
      tags: [`tenant:${tenantA}`],
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })
    const registryA = createToolRegistry(testEnv, tenantA, tmkA)
    const registryB = createToolRegistry(testEnv, tenantB, tmkB)
    const semantic = await callTool<CanonicalSearchResult>(registryA, 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })

    await expect(callTool(
      registryB,
      'get_memory_trace',
      { query_id: semantic.broker!.queryId },
    )).rejects.toThrow(/Broker trace not found/)

    const foreignRecent = await callTool<CanonicalBrokerTraceListResult>(registryB, 'get_recent_memory_traces', { limit: 5 })
    expect(foreignRecent.items).toEqual([])
  })

  it('makes brokered prepare_context_for_agent queries visible through trace readback', async () => {
    const tenantId = uniqueTenantId('context')
    const tmk = await deriveTestTmk(tenantId)
    await ensureTenantWithKek(tenantId)
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults })
    const seeded = await captureAndProject({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'context',
      tenantId,
      testEnv,
      tmk,
    })
    recallResults.splice(0, recallResults.length, {
      id: 'context-semantic',
      document_id: seeded.engineDocumentId,
      text: 'The operations checklist still needs an owner before the next meeting.',
      score: 0.96,
      tags: [`tenant:${tenantId}`],
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })
    const registry = createToolRegistry(testEnv, tenantId, tmk)

    await callTool<Record<string, unknown>>(registry, 'prepare_context_for_agent', {
      agent: 'chief_of_staff',
      intent: 'person',
      target: 'User',
      limit: 4,
    } satisfies PrepareContextForAgentInput)

    const traces = await callTool<CanonicalBrokerTraceListResult>(registry, 'get_recent_memory_traces', { limit: 10 })
    const hydrated = await Promise.all(
      traces.items.slice(0, 4).map((item) => callTool<CanonicalBrokerTraceView>(registry, 'get_memory_trace', {
        query_id: item.queryId,
      })),
    )
    const queryTexts = hydrated.map((trace) => trace.queryText).filter((value): value is string => Boolean(value))

    expect(traces.items.length).toBeGreaterThanOrEqual(4)
    expect(queryTexts).toEqual(expect.arrayContaining([
      'Brief me on User',
      'What do I know about User?',
      'How has my relationship with User changed over time?',
      'User',
    ]))
    expect(hydrated.some((trace) => trace.route.mode === 'semantic')).toBe(true)
    expect(hydrated.some((trace) => trace.route.mode === 'graph')).toBe(true)
    expect(hydrated.every((trace) => trace.detailStatus === 'ok')).toBe(true)
  })
})
