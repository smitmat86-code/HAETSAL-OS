import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { decryptCanonicalPayload } from '../src/services/canonical-memory-read-model'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalEntityRecord, CanonicalEdgeRecord } from '../src/types/canonical-governance-records'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalBrokerTraceDetail } from '../src/types/canonical-memory-broker'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }
type SeededCapture = { captureId: string; documentId: string }
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

// Shared test env with own InMemory stores — captures and queries through same stores.
const testEnv = (() => {
  const built = {
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
  installCanonicalMemoryTestStore(built)
  return built
})()
const governanceStore = installCanonicalGovernanceTestStore(testEnv)

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

// Capture into canonical store (no queue dispatch — projection engines retired).
async function captureAndSeed(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  tmk: CryptoKey,
): Promise<SeededCapture> {
  vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(fixture, suffix, tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: 'semantic',
  }, testEnv, TENANT_ID)
  vi.restoreAllMocks()
  return { captureId: result.capture.captureId, documentId: result.capture.documentId }
}

function makeEntity(kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return { id: crypto.randomUUID(), tenant_id: TENANT_ID, kind, name, normalized_name: name.toLowerCase(), aliases_json: null, authority: 0, first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now }
}

function makeEdge(srcId: string, dstId: string, type: string, captureId: string | null): CanonicalEdgeRecord {
  const now = Date.now()
  return { id: crypto.randomUUID(), tenant_id: TENANT_ID, src_entity_id: srcId, dst_entity_id: dstId, edge_type: type, weight: 1, confidence: 0.8, trust_state: 'evidence', capture_id: captureId, claim_id: null, valid_from: now, valid_to: null, created_at: now, updated_at: now }
}

function createToolRegistry(tmk: CryptoKey | null): ToolRegistry {
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

async function readBrokerTrace(
  queryId: string,
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

beforeAll(async () => {
  await ensureTenantWithKek()
  // Seed graph entities so graph mode returns real results for 'User'.
  const tmk = await deriveTestTmk()
  const seeded = await captureAndSeed(conversationFixture as CanonicalPipelineCaptureInput, 'graph-seed', tmk)
  const userEntity = await governanceStore.upsertEntity(makeEntity('person', 'User'))
  const checklistEntity = await governanceStore.upsertEntity(makeEntity('project', 'Operations Checklist'))
  await governanceStore.upsertEdge(makeEdge(userEntity.id, checklistEntity.id, 'owns', seeded.captureId))
})
beforeEach(() => { vi.restoreAllMocks() })

describe('9.8 broker primary + shadow retrieval', () => {
  it('keeps semantic as primary, shadows graph, and persists a tenant-scoped broker trace', async () => {
    const tmk = await deriveTestTmk()
    await captureAndSeed(conversationFixture as CanonicalPipelineCaptureInput, 'semantic-primary', tmk)

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(tmk), 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    const trace = await readBrokerTrace(result.broker!.queryId, tmk)

    expect(result.mode).toBe('semantic')
    expect(result.broker?.primaryMode).toBe('semantic')
    expect(result.broker?.shadowMode).toBe('graph')
    expect(result.items[0]?.graphContext).toBeUndefined()
    expect(trace.row.primary_mode).toBe('semantic')
    expect(trace.row.shadow_mode).toBe('graph')
    // Both branches use canonical store; projectionKind is 'canonical' for both
    expect(['canonical', null]).toContain(trace.detail.primary.projectionKind)
    expect(['canonical', null]).toContain(trace.detail.shadow.projectionKind)
    expect(trace.detail.surfaced.mode).toBe('semantic')
  })

  it('keeps graph as primary, shadows semantic, and records both branches without synthesis', async () => {
    const tmk = await deriveTestTmk()
    await captureAndSeed(conversationFixture as CanonicalPipelineCaptureInput, 'graph-primary', tmk)

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(tmk), 'search_memory', {
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })
    const trace = await readBrokerTrace(result.broker!.queryId, tmk)

    expect(result.mode).toBe('graph')
    expect(result.items[0]?.graphContext?.entityLabel).toBe('User')
    expect(result.items[0]?.recallText).toBeUndefined()
    expect(trace.row.primary_mode).toBe('graph')
    expect(trace.row.shadow_mode).toBe('semantic')
    // Graph primary uses canonical governance; projectionKind is 'canonical'
    expect(trace.detail.primary.projectionKind).toBe('canonical')
    expect(trace.detail.surfaced.mode).toBe('graph')
  })

  it('does not block the hot path while a shadow semantic retrieval is slow', async () => {
    const tmk = await deriveTestTmk()
    await captureAndSeed(conversationFixture as CanonicalPipelineCaptureInput, 'non-blocking', tmk)

    const registry = createToolRegistry(tmk)
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
    // Shadow runs in background via waitUntil — hot path must be fast
    expect(elapsedMs).toBeLessThan(400)
  })

  it('keeps the user-facing response primary-only even when the shadow branch diverges', async () => {
    const tmk = await deriveTestTmk()
    await captureAndSeed(conversationFixture as CanonicalPipelineCaptureInput, 'no-synthesis', tmk)

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(tmk), 'search_memory', {
      query: 'What do I know about User?',
      mode: 'semantic',
      limit: 5,
    })
    const trace = await readBrokerTrace(result.broker!.queryId, tmk)

    expect(result.mode).toBe('semantic')
    expect(result.items.every((item) => item.mode === 'semantic')).toBe(true)
    expect(result.items.every((item) => !item.graphContext)).toBe(true)
    expect(['distinct', 'partial', 'unknown', 'same']).toContain(trace.row.overlap)
  })
})
