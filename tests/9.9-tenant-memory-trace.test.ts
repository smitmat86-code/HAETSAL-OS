import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalEntityRecord, CanonicalEdgeRecord } from '../src/types/canonical-governance-records'
import type {
  CanonicalBrokerTraceListResult,
  CanonicalBrokerTraceView,
} from '../src/types/canonical-memory-broker'
import type { PrepareContextForAgentInput } from '../src/types/chief-of-staff-context'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }
type SeededCapture = { captureId: string; documentId: string }

// Deterministic bag-of-words pseudo-embedder.
function pseudoVector(text: string): number[] {
  const vector = new Array<number>(32).fill(0)
  for (const token of text.toLowerCase().split(/\W+/).filter((t) => t.length > 2)) {
    let hash = 0
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0
    vector[hash % 32] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
  return vector.map((v) => v / norm)
}

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

// Each test creates its own isolated env with InMemory stores.
function makeTestEnv(): { testEnv: typeof env; governanceStore: ReturnType<typeof installCanonicalGovernanceTestStore> } {
  const testEnv = {
    ...env,
    WORKER_DOMAIN: 'haetsalos.test',
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((t) => pseudoVector(t)),
      }),
    },
    HINDSIGHT: { fetch: async () => { throw new Error('Hindsight must not be called') } },
    GRAPHITI: { fetch: async () => { throw new Error('Graphiti must not be called') } },
  } as unknown as typeof env
  installCanonicalMemoryTestStore(testEnv)
  const governanceStore = installCanonicalGovernanceTestStore(testEnv)
  return { testEnv, governanceStore }
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

// Capture into canonical store; no queue dispatch (projection engines retired).
async function captureAndSeed(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  tenantId: string
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<SeededCapture> {
  vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, args.tenantId, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: 'semantic',
  }, args.testEnv, args.tenantId)
  vi.restoreAllMocks()
  return { captureId: result.capture.captureId, documentId: result.capture.documentId }
}

function makeEntity(tenantId: string, kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return { id: crypto.randomUUID(), tenant_id: tenantId, kind, name, normalized_name: name.toLowerCase(), aliases_json: null, authority: 0, first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now }
}

function makeEdge(tenantId: string, srcId: string, dstId: string, type: string, captureId: string | null): CanonicalEdgeRecord {
  const now = Date.now()
  return { id: crypto.randomUUID(), tenant_id: tenantId, src_entity_id: srcId, dst_entity_id: dstId, edge_type: type, weight: 1, confidence: 0.8, trust_state: 'evidence', capture_id: captureId, claim_id: null, valid_from: now, valid_to: null, created_at: now, updated_at: now }
}

async function readBrokerTraceRow(
  testEnv: typeof env,
  tenantId: string,
  queryId: string,
): Promise<{ detail_r2_key: string | null }> {
  const row = await testEnv.D1_US.prepare(
    `SELECT detail_r2_key
     FROM canonical_broker_traces
     WHERE tenant_id = ? AND id = ?`,
  ).bind(tenantId, queryId).first<{ detail_r2_key: string | null }>()
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
    const { testEnv, governanceStore } = makeTestEnv()
    const seeded = await captureAndSeed({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'recent', tenantId, testEnv, tmk })
    const userEntity = await governanceStore.upsertEntity(makeEntity(tenantId, 'person', 'User'))
    const checklistEntity = await governanceStore.upsertEntity(makeEntity(tenantId, 'project', 'Operations Checklist'))
    await governanceStore.upsertEdge(makeEdge(tenantId, userEntity.id, checklistEntity.id, 'owns', seeded.captureId))

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
    expect(semanticOnly.items.map((item) => item.queryId)).toEqual([semantic.broker!.queryId])
  })

  it('hydrates full detail for semantic-primary and graph-primary broker queries', async () => {
    const tenantId = uniqueTenantId('hydrate')
    const tmk = await deriveTestTmk(tenantId)
    await ensureTenantWithKek(tenantId)
    const { testEnv, governanceStore } = makeTestEnv()
    // Seed a document body designed to share tokens with "What do I know about User?"
    // so pgvector cosine similarity exceeds the 0.3 threshold.
    const semanticBody = 'What do I know about User? User knows about the checklist and needs an owner.'
    const semanticCapture: CanonicalPipelineCaptureInput = { tenantId, sourceSystem: 'mcp_memory_write', sourceRef: 'hydrate-semantic', scope: 'general', title: 'User knowledge', body: semanticBody }
    const seeded = await captureAndSeed({ fixture: semanticCapture, suffix: 'hydrate-sem', tenantId, testEnv, tmk })
    // Also seed conversation fixture for graph coverage
    const convSeeded = await captureAndSeed({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'hydrate-graph', tenantId, testEnv, tmk })
    const userEntity = await governanceStore.upsertEntity(makeEntity(tenantId, 'person', 'User'))
    const checklistEntity = await governanceStore.upsertEntity(makeEntity(tenantId, 'project', 'Operations Checklist'))
    await governanceStore.upsertEdge(makeEdge(tenantId, userEntity.id, checklistEntity.id, 'owns', convSeeded.captureId))
    void seeded

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
    expect(semanticTrace.shadow.mode).toBe('graph')
    // Semantic search via pgvector finds the seeded document → summary is non-null
    expect(semanticTrace.surfaced.summary).toBeTruthy()

    expect(graphTrace.detailStatus).toBe('ok')
    expect(graphTrace.queryText).toBe('How has my relationship with User changed over time?')
    expect(graphTrace.route.mode).toBe('graph')
    // Graph mode uses canonical governance — projectionKind is 'canonical'
    expect(graphTrace.primary.projectionKind).toBe('canonical')
    expect(graphTrace.shadow.mode).toBe('semantic')
    expect(graphTrace.primary.summary).toContain('User')
  })

  it('degrades gracefully when the rich detail blob is missing', async () => {
    const tenantId = uniqueTenantId('missing')
    const tmk = await deriveTestTmk(tenantId)
    await ensureTenantWithKek(tenantId)
    const { testEnv } = makeTestEnv()
    await captureAndSeed({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'missing', tenantId, testEnv, tmk })

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
    // Semantic via pgvector may return 'ok' (with items) or 'empty' (no items above threshold)
    expect(['ok', 'empty', 'partial']).toContain(trace.primary.status)
    expect(traces.items[0]?.detailStatus).toBe('missing')
    expect(traces.items[0]?.surfacedSummary).toBeNull()
  })

  it('rejects cross-tenant trace access', async () => {
    const tenantA = uniqueTenantId('tenant-a')
    const tenantB = uniqueTenantId('tenant-b')
    const tmkA = await deriveTestTmk(tenantA)
    const tmkB = await deriveTestTmk(tenantB)
    await Promise.all([ensureTenantWithKek(tenantA), ensureTenantWithKek(tenantB)])
    const { testEnv } = makeTestEnv()
    await captureAndSeed({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'cross-tenant', tenantId: tenantA, testEnv, tmk: tmkA })

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
    const { testEnv, governanceStore } = makeTestEnv()
    const seeded = await captureAndSeed({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'context', tenantId, testEnv, tmk })
    const userEntity = await governanceStore.upsertEntity(makeEntity(tenantId, 'person', 'User'))
    const checklistEntity = await governanceStore.upsertEntity(makeEntity(tenantId, 'project', 'Operations Checklist'))
    await governanceStore.upsertEdge(makeEdge(tenantId, userEntity.id, checklistEntity.id, 'owns', seeded.captureId))

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
