import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureCanonicalMemory } from '../src/services/canonical-memory'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalCaptureInput } from '../src/types/canonical-memory'
import type {
  CanonicalDocumentResult,
  CanonicalMemoryStatsResult,
  CanonicalMemoryStatusResult,
  CanonicalRecentResult,
  CanonicalSearchResult,
} from '../src/types/canonical-memory-query'
import artifactFixture from './fixtures/canonical-memory/artifact-capture.json'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import documentQueryFixture from './fixtures/canonical-memory/document-query.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'
import searchQueryFixture from './fixtures/canonical-memory/note-search-query.json'
import recentQueryFixture from './fixtures/canonical-memory/recent-query.json'
import statusQueryFixture from './fixtures/canonical-memory/status-query.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-canonical-62-${SUITE_ID}`
const TENANT_B = `test-tenant-canonical-62-b-${SUITE_ID}`

let suiteTmk: CryptoKey
let seeded: {
  note: { captureId: string; documentId: string; operationId: string }
  conversation: { captureId: string; documentId: string; operationId: string }
  artifact: { captureId: string; documentId: string; operationId: string }
}

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-memory-surface-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-memory-surface-salt'),
      info: new TextEncoder().encode('canonical-memory-surface-info'),
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
  fixture: CanonicalCaptureInput,
  tenantId: string,
  sourceRefSuffix: string,
): Promise<CanonicalCaptureInput> {
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${sourceRefSuffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, suiteTmk),
    artifactRef: fixture.artifactRef
      ? {
        ...fixture.artifactRef,
        contentEncrypted: await encryptContentForArchive(`artifact-${sourceRefSuffix}`, suiteTmk),
      }
      : null,
  }
}

async function markHindsightProjectionCompleted(operationId: string): Promise<void> {
  const store = getCanonicalMemoryStore(env)
  const jobs = await store.listProjectionJobsForOperation(TENANT_A, operationId)
  const hindsightJob = jobs.find(job => job.projection_kind === 'hindsight')
  if (!hindsightJob) return
  const now = Date.now()
  await store.recordProjectionState({
    tenantId: TENANT_A,
    jobId: hindsightJob.id,
    operationId,
    jobStatus: 'completed',
    resultStatus: 'completed',
    targetRef: `hindsight://memory/${operationId}`,
    updatedAt: now,
  })
}

function createToolRegistry(tmk: CryptoKey | null, tenantId = TENANT_A, testEnv: typeof env = env): ToolRegistry {
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
    getExecutionContext: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }),
  })
  return { handlers, pending }
}

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown = {}): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

beforeAll(async () => {
  suiteTmk = await deriveTestTmk()
  await Promise.all([ensureTenant(TENANT_A), ensureTenant(TENANT_B)])
  seeded = {
    note: await captureCanonicalMemory(await encryptFixture(noteFixture as CanonicalCaptureInput, TENANT_A, 'note'), env, TENANT_A),
    conversation: await captureCanonicalMemory(await encryptFixture(conversationFixture as CanonicalCaptureInput, TENANT_A, 'conversation'), env, TENANT_A),
    artifact: await captureCanonicalMemory(await encryptFixture(artifactFixture as CanonicalCaptureInput, TENANT_A, 'artifact'), env, TENANT_A),
  }
  await captureCanonicalMemory(await encryptFixture(noteFixture as CanonicalCaptureInput, TENANT_B, 'foreign'), env, TENANT_B)
  await markHindsightProjectionCompleted(seeded.note.operationId)
})

describe('6.2 canonical MCP memory surface', () => {
  it('registers the canonical tool names and keeps capture_memory callable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = createToolRegistry(null)
    const result = await callTool<{ status: string }>(registry, 'capture_memory', {
      content: 'Bridge the current capture path',
      scope: 'general',
    })

    expect(Array.from(registry.handlers.keys()).sort()).toEqual([
      'capture_memory',
      'debug_hindsight_bank_state',
      'get_document',
      'get_entity_timeline',
      'get_memory_trace',
      'get_recent_memories',
      'get_recent_memory_traces',
      'memory_stats',
      'memory_status',
      'prepare_context_for_agent',
      'search_memory',
      'trace_relationship',
    ])
    expect(result.status).toBe('deferred')
  })

  it('searches canonical memory without exposing engine-specific names', async () => {
    const result = await callTool<CanonicalSearchResult>(
      createToolRegistry(suiteTmk),
      'search_memory',
      searchQueryFixture,
    )

    expect(result.items[0]?.documentId).toBe(seeded.note.documentId)
    expect(result.items[0]?.sourceSystem).toBe('mcp_retain')
    expect(result.items[0]?.preview).toContain('productive planning session')
  })

  it('lists recent canonical captures in the expected tenant-scoped order', async () => {
    const result = await callTool<CanonicalRecentResult>(
      createToolRegistry(suiteTmk),
      'get_recent_memories',
      recentQueryFixture,
    )

    expect(result.items.map(item => item.captureId)).toEqual([
      seeded.conversation.captureId,
      seeded.note.captureId,
    ])
  })

  it('returns canonical documents through the approved decrypt path', async () => {
    const result = await callTool<CanonicalDocumentResult>(
      createToolRegistry(suiteTmk),
      'get_document',
      { ...documentQueryFixture, document_id: seeded.note.documentId },
    )

    expect(result.documentId).toBe(seeded.note.documentId)
    expect(result.body).toContain('following up with two open questions tomorrow')
    expect(result.scope).toBe('general')
  })

  it('returns canonical operation and projection job status', async () => {
    const result = await callTool<CanonicalMemoryStatusResult>(
      createToolRegistry(suiteTmk),
      'memory_status',
      { ...statusQueryFixture, operation_id: seeded.note.operationId },
    )

    expect(result.operation.status).toBe('queued')
    expect(result.projections.map(item => item.kind)).toEqual(expect.arrayContaining(['hindsight', 'graphiti']))
    expect(result.projections.find(item => item.kind === 'hindsight')?.status).toBe('completed')
  })

  it('can inspect raw hindsight bank state for the current tenant', async () => {
    const testEnv = {
      ...env,
      HINDSIGHT: {
        fetch: async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
          if (/\/operations\/[^/]+$/.test(url.pathname)) {
            return new Response(JSON.stringify({
              operation_id: 'remote-op-62',
              status: 'completed',
              operation_type: 'retain',
              completed_at: new Date().toISOString(),
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          if (/\/documents\/[^/]+$/.test(url.pathname)) {
            return new Response(JSON.stringify({
              id: 'remote-doc-62',
              bank_id: `hindsight-${TENANT_A}`,
              memory_unit_count: 2,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          if (/\/memories\/recall$/.test(url.pathname)) {
            return new Response(JSON.stringify({
              results: [{
                document_id: 'remote-doc-62',
                text: 'The direct bank probe can see this retained memory.',
                score: 0.98,
              }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        },
      },
    } as typeof env

    const now = Date.now()
    const store = getCanonicalMemoryStore(env)
    const hindsightJob = (await store.listProjectionJobsForOperation(TENANT_A, seeded.note.operationId))
      .find((job) => job.projection_kind === 'hindsight')
    expect(hindsightJob).toBeTruthy()
    await store.recordProjectionState({
      tenantId: TENANT_A,
      jobId: hindsightJob!.id,
      operationId: seeded.note.operationId,
      jobStatus: 'completed',
      resultStatus: 'completed',
      targetRef: 'hindsight://bank/documents/remote-doc-62/operations/remote-op-62',
      engineDocumentId: 'remote-doc-62',
      engineOperationId: 'remote-op-62',
      updatedAt: now,
    })

    const result = await callTool<Record<string, unknown>>(
      createToolRegistry(suiteTmk, TENANT_A, testEnv),
      'debug_hindsight_bank_state',
      {
        operation_id: seeded.note.operationId,
        recall_query: 'direct bank probe retained memory',
        limit: 3,
      },
    )

    expect(result.bankId).toBe(`hindsight-${TENANT_A}`)
    expect((result.projection as Record<string, unknown>).engineDocumentId).toBe('remote-doc-62')
    expect((result.remoteOperation as Record<string, unknown>).status).toBe('completed')
    expect((result.remoteDocument as Record<string, unknown>).memory_unit_count).toBe(2)
    expect((result.rawRecall as Record<string, unknown>).count).toBe(1)
  })

  it('returns tenant-scoped canonical memory stats without exposing content', async () => {
    const result = await callTool<CanonicalMemoryStatsResult>(
      createToolRegistry(suiteTmk),
      'memory_stats',
    )

    expect(result.captureCount).toBe(3)
    expect(result.documentCount).toBe(3)
    expect(result.operationCount).toBe(3)
    expect(result.pendingProjectionCount).toBe(5)
    expect(result.completedProjectionCount).toBe(1)
    expect(result.scopes).toEqual([
      { scope: 'general', count: 2 },
      { scope: 'research', count: 1 },
    ])
  })

  it('rejects cross-tenant canonical document access', async () => {
    await expect(callTool(
      createToolRegistry(suiteTmk, TENANT_B),
      'get_document',
      { document_id: seeded.note.documentId },
    )).rejects.toThrow(/Canonical document not found/)
  })
})
