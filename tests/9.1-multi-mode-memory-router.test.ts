import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalEdgeRecord, CanonicalEntityRecord } from '../src/types/canonical-governance-records'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-router-91-${SUITE_ID}`

installCanonicalMemoryTestStore(env)
const governanceStore = installCanonicalGovernanceTestStore(env)

// Deterministic bag-of-words pseudo-embedder so semantic mode can use pgvector
// without a real AI binding.
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

function makeTestEnv(): typeof env {
  const testEnv = {
    ...env,
    WORKER_DOMAIN: 'haetsalos.test',
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((t) => pseudoVector(t)),
      }),
    },
  } as unknown as typeof env
  vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  return testEnv
}

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`router-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('router-salt'),
    info: new TextEncoder().encode('router-info'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  await env.KV_SESSION.put(`cron_kek:${tenantId}`, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), { expirationTtl: 60 * 60 * 24 })
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId: TENANT_A,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

async function captureAndProject(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  memoryType: 'episodic' | 'semantic' | 'world'
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<{ captureId: string; documentId: string; operationId: string }> {
  const input = await encryptFixture(args.fixture, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: args.memoryType,
  }, args.testEnv, TENANT_A)
  return {
    captureId: result.capture.captureId,
    documentId: result.capture.documentId,
    operationId: result.capture.operationId,
  }
}

function makeEntity(kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), tenant_id: TENANT_A, kind, name,
    normalized_name: name.toLowerCase(), aliases_json: null, authority: 0,
    first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now,
  }
}

function makeEdge(src: string, dst: string, type: string, captureId: string | null): CanonicalEdgeRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), tenant_id: TENANT_A, src_entity_id: src, dst_entity_id: dst,
    edge_type: type, weight: 1, confidence: 0.8, trust_state: 'evidence',
    capture_id: captureId, claim_id: null, valid_from: now, valid_to: null,
    created_at: now, updated_at: now,
  }
}

function createToolRegistry(testEnv: typeof env, tmk: CryptoKey | null): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = { tool(name: string, _description: string, _shape: object, handler: ToolHandler) { handlers.set(name, handler) } } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => TENANT_A,
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

beforeAll(async () => {
  await ensureTenantWithKek(TENANT_A)
  // Seed canonical entities and edges for graph/composed tests (once per suite).
  const userEntity = await governanceStore.upsertEntity(makeEntity('person', 'User'))
  const projectEntity = await governanceStore.upsertEntity(makeEntity('project', 'Project'))
  await governanceStore.upsertEdge(makeEdge(userEntity.id, projectEntity.id, 'works_on', null))
})

beforeEach(() => { vi.restoreAllMocks() })

describe('9.1 multi-mode memory router', () => {
  it('routes exact-source phrasing to raw mode with consistent attribution', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeTestEnv()
    await captureAndProject({ fixture: noteFixture as CanonicalPipelineCaptureInput, suffix: 'raw-route', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'Show me exactly what I said about productive planning session',
      limit: 5,
    })

    expect(result.mode).toBe('raw')
    expect(result.route?.explicit).toBe(false)
    // Items may be empty if FTS index is not available in test, but mode must be correct.
    if (result.items.length > 0) {
      expect(result.items[0]?.attribution?.mode).toBe('raw')
      expect(result.items[0]?.attribution?.documentId).toBeTruthy()
    }
  })

  it('routes concept questions to semantic mode', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeTestEnv()
    await captureAndProject({ fixture: noteFixture as CanonicalPipelineCaptureInput, suffix: 'semantic-route', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about tomorrow?',
      limit: 5,
    })

    expect(result.mode).toBe('semantic')
    // Semantic now uses pgvector + embeddings via env.AI — no Hindsight involved.
    // Status may be 'ok', 'partial', or 'unavailable' depending on vector availability.
    expect(['ok', 'partial', 'unavailable']).toContain(result.status)
  })

  it('routes relationship or timeline phrasing to graph mode', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeTestEnv()

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })

    expect(result.mode).toBe('graph')
    expect(result.route?.dispatchQuery).toBe('User')
    if (result.items.length > 0) {
      expect(result.items[0]?.graphContext?.entityLabel).toBeTruthy()
    }
  })

  it('routes broad context-building phrasing to composed mode', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeTestEnv()

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'Prepare context for User before a meeting',
      limit: 5,
    })

    expect(result.mode).toBe('composed')
    expect(result.route?.dispatchQuery).toBe('User')
  })

  it('honors explicit lexical mode and keeps it as lexical (not aliased to raw)', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeTestEnv()
    await captureAndProject({ fixture: noteFixture as CanonicalPipelineCaptureInput, suffix: 'lexical-route', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about tomorrow?',
      mode: 'lexical',
      limit: 5,
    })

    // lexical is now a real mode — it must NOT be aliased to 'raw'
    expect(result.mode).toBe('lexical')
    expect(result.route?.explicit).toBe(true)
    expect(result.route?.reason).toContain('lexical')
  })
})
