import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createHindsightTestEnv, type HindsightRecallRow } from './support/hindsight-test-env'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-router-91-${SUITE_ID}`

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

function createRuntimeEnv(state: {
  recallResults: HindsightRecallRow[]
  failRecall?: boolean
}): typeof env {
  return {
    ...createHindsightTestEnv({
      recallResults: state.recallResults,
      failRecall: state.failRecall ?? false,
      operationStatus: 'completed',
    }),
    GRAPHITI_API_URL: 'https://graphiti.internal',
    GRAPHITI_API_TOKEN: 'graphiti-test-token',
  } as typeof env
}

function buildCompletedGraphResponse(body: Record<string, any>) {
  return {
    status: 'completed',
    targetRef: `graphiti://episodes/${body.captureId}`,
    episodeRefs: [`graphiti://episodes/${body.captureId}`],
    entityRefs: (body.plan.entities as Array<Record<string, unknown>>).map((_: unknown, index: number) => `graphiti://entities/${body.captureId}-${index}`),
    edgeRefs: (body.plan.edges as Array<Record<string, unknown>>).map((_: unknown, index: number) => `graphiti://edges/${body.captureId}-${index}`),
    mappings: [
      { canonicalKey: body.plan.episode.canonicalKey, graphRef: `graphiti://episodes/${body.captureId}`, graphKind: 'episode' },
      ...(body.plan.entities as Array<Record<string, unknown>>).map((entity, index: number) => ({
        canonicalKey: entity.canonicalKey, graphRef: `graphiti://entities/${body.captureId}-${index}`, graphKind: 'entity',
      })),
      ...(body.plan.edges as Array<Record<string, unknown>>).map((edge, index: number) => ({
        canonicalKey: edge.canonicalKey, graphRef: `graphiti://edges/${body.captureId}-${index}`, graphKind: 'edge',
      })),
    ],
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

async function captureAndProject(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  memoryType: 'episodic' | 'semantic' | 'world'
  testEnv: typeof env
  tmk: CryptoKey
  compatibilityMode?: 'off' | 'current_hindsight'
}): Promise<{
  captureId: string
  documentId: string
  operationId: string
  engineDocumentId: string | null
}> {
  const originalFetch = globalThis.fetch
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input)
    if (!url.includes('graphiti.internal')) return originalFetch(input, init)
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}'))) as Record<string, any>
    return new Response(JSON.stringify(buildCompletedGraphResponse(body)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const input = await encryptFixture(args.fixture, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    compatibilityMode: args.compatibilityMode ?? 'off',
    memoryType: args.memoryType,
  }, args.testEnv, TENANT_A)
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, args.testEnv)
  sendSpy.mockRestore()
  const projection = await args.testEnv.D1_US.prepare(
    `SELECT r.engine_document_id
     FROM canonical_projection_results r
     INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
     WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC LIMIT 1`,
  ).bind(TENANT_A, result.capture.operationId).first<{ engine_document_id: string }>()
  return {
    captureId: result.capture.captureId,
    documentId: result.capture.documentId,
    operationId: result.capture.operationId,
    engineDocumentId: projection?.engine_document_id ?? null,
  }
}

beforeAll(async () => { await ensureTenantWithKek(TENANT_A) })
beforeEach(() => { vi.restoreAllMocks() })

describe('9.1 multi-mode memory router', () => {
  it('routes exact-source phrasing to raw mode with consistent attribution', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createRuntimeEnv({ recallResults: [] })
    await captureAndProject({ fixture: noteFixture as CanonicalPipelineCaptureInput, suffix: 'raw-route', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'Show me exactly what I said about productive planning session',
      limit: 5,
    })

    expect(result.mode).toBe('raw')
    expect(result.route?.explicit).toBe(false)
    expect(result.items[0]?.attribution?.mode).toBe('raw')
    expect(result.items[0]?.attribution?.documentId).toBeTruthy()
    expect(result.items[0]?.attribution?.projectionKind).toBeNull()
  })

  it('routes concept questions to semantic mode with normalized attribution', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createRuntimeEnv({ recallResults: [] })
    const seeded = await captureAndProject({
      fixture: noteFixture as CanonicalPipelineCaptureInput,
      suffix: 'semantic-route',
      memoryType: 'episodic',
      testEnv,
      tmk,
      compatibilityMode: 'current_hindsight',
    })
    const baseFetch = testEnv.HINDSIGHT.fetch
    testEnv.HINDSIGHT.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
      if (/^\/v1\/default\/banks\/[^/]+\/memories\/recall$/.test(url.pathname)) {
        return Response.json({
          results: [{
            id: 'semantic-result',
            document_id: seeded.engineDocumentId,
            text: 'The user committed to following up with two open questions tomorrow.',
            score: 0.93,
            metadata: { source: 'mcp_retain', domain: 'general' },
          }],
          text: 'Found 1 semantic memories.',
        })
      }
      return baseFetch(input, init)
    }

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about tomorrow?',
      limit: 5,
    })

    expect(result.mode).toBe('semantic')
    expect(result.items[0]?.attribution?.projectionKind).toBe('hindsight')
    expect(result.items[0]?.attribution?.canonicalOperationId).toBe(seeded.operationId)
  })

  it('routes relationship or timeline phrasing to graph mode', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createRuntimeEnv({ recallResults: [] })
    await captureAndProject({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'graph-route', memoryType: 'semantic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'How has my relationship with User changed over time?',
      limit: 5,
    })

    expect(result.mode).toBe('graph')
    expect(result.route?.dispatchQuery).toBe('User')
    expect(result.items[0]?.attribution?.projectionKind).toBe('graphiti')
    expect(result.items[0]?.graphContext?.entityLabel).toBe('User')
  })

  it('routes broad context-building phrasing to composed mode', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createRuntimeEnv({ recallResults: [] })
    await captureAndProject({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'composed-route', memoryType: 'semantic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'Prepare context for User before a meeting',
      limit: 5,
    })

    expect(result.mode).toBe('composed')
    expect(result.route?.dispatchQuery).toBe('User')
    expect(result.items[0]?.mode).toBe('composed')
    expect(result.items[0]?.attribution?.projectionKind).toBe('graphiti')
  })

  it('honors explicit mode override and accepts lexical as a raw alias', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createRuntimeEnv({ recallResults: [] })
    await captureAndProject({ fixture: noteFixture as CanonicalPipelineCaptureInput, suffix: 'explicit-route', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about tomorrow?',
      mode: 'lexical',
      limit: 5,
    })

    expect(result.mode).toBe('raw')
    expect(result.route?.explicit).toBe(true)
    expect(result.route?.reason).toContain('Caller requested raw mode')
  })
})
