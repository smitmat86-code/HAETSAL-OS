import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type {
  CanonicalMemoryStatusResult,
  CanonicalSearchResult,
} from '../src/types/canonical-memory-query'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createHindsightTestEnv, type HindsightCaptureState, type HindsightRecallRow } from './support/hindsight-test-env'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-canonical-72-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-semantic-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-semantic-salt'),
      info: new TextEncoder().encode('canonical-semantic-info'),
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
  const kekBytes = crypto.getRandomValues(new Uint8Array(32))
  await env.KV_SESSION.put(
    `cron_kek:${tenantId}`,
    btoa(String.fromCharCode(...kekBytes)),
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

function replaceRecallResults(target: HindsightRecallRow[], next: HindsightRecallRow[]): void {
  target.splice(0, target.length, ...next)
}

function createToolRegistry(testEnv: typeof env, tmk: CryptoKey | null): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = {
    tool(name: string, _description: string, _shape: object, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => TENANT_A,
    getTmk: () => tmk,
    getExecutionContext: () => ({
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
    }),
  })
  return { handlers, pending }
}

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

async function processDispatch(
  message: { tenantId: string; payload: Record<string, unknown> },
  testEnv: typeof env,
): Promise<void> {
  const pending: Promise<unknown>[] = []
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, testEnv, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  })
  await Promise.allSettled(pending)
}

async function captureAndProject(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  memoryType: 'episodic' | 'semantic' | 'world'
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<{ captureId: string; documentId: string; operationId: string; engineDocumentId: string }> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, TENANT_A, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: args.memoryType,
    compatibilityMode: 'current_hindsight',
  }, args.testEnv, TENANT_A)
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processDispatch(message, args.testEnv)
  sendSpy.mockRestore()
  const projection = await args.testEnv.D1_US.prepare(
    `SELECT r.engine_document_id
     FROM canonical_projection_results r
     INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
     WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
     LIMIT 1`,
  ).bind(TENANT_A, result.capture.operationId).first<{ engine_document_id: string }>()
  return {
    captureId: result.capture.captureId,
    documentId: result.capture.documentId,
    operationId: result.capture.operationId,
    engineDocumentId: projection!.engine_document_id,
  }
}

beforeAll(async () => {
  await ensureTenantWithKek(TENANT_A)
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('7.2 semantic recall through canonical interface', () => {
  it('returns a note-style semantic memory through search_memory with canonical provenance', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const testEnv = createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults })
    const seeded = await captureAndProject({
      fixture: noteFixture as CanonicalPipelineCaptureInput,
      suffix: 'note-semantic',
      memoryType: 'episodic',
      testEnv,
      tmk,
    })

    replaceRecallResults(recallResults, [{
      id: 'semantic-note-result',
      document_id: seeded.engineDocumentId,
      text: 'The user committed to following up with two open questions tomorrow.',
      score: 0.97,
      metadata: { source: 'mcp_retain', domain: 'general' },
    }])

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What follow-up is due tomorrow?',
      mode: 'semantic',
      limit: 3,
    })

    expect(result.mode).toBe('semantic')
    expect(result.status).toBe('ok')
    expect(result.items[0]?.documentId).toBe(seeded.documentId)
    expect(result.items[0]?.provenance?.captureId).toBe(seeded.captureId)
    expect(result.items[0]?.provenance?.canonicalOperationId).toBe(seeded.operationId)
    expect(result.items[0]?.semanticStatus?.ready).toBe(true)
    expect(result.items[0]?.recallText).toContain('two open questions tomorrow')
  })

  it('returns a conversation-style semantic memory through the canonical surface', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const testEnv = createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults })
    const seeded = await captureAndProject({
      fixture: conversationFixture as CanonicalPipelineCaptureInput,
      suffix: 'conversation-semantic',
      memoryType: 'semantic',
      testEnv,
      tmk,
    })

    replaceRecallResults(recallResults, [{
      id: 'semantic-conversation-result',
      document_id: seeded.engineDocumentId,
      text: 'The rollout notes should keep the checklist owner as an explicit follow-up item.',
      score: 0.91,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    }])

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'Who still owns the operations checklist?',
      mode: 'semantic',
      limit: 3,
    })

    expect(result.mode).toBe('semantic')
    expect(result.status).toBe('ok')
    expect(result.items[0]?.captureId).toBe(seeded.captureId)
    expect(result.items[0]?.documentId).toBe(seeded.documentId)
    expect(result.items[0]?.sourceSystem).toBe('mcp_memory_write')
    expect(result.items[0]?.semanticStatus?.ready).toBe(true)
    expect(result.items[0]?.preview).toContain('checklist owner')
  })

  it('marks mixed canonical and local-only semantic results as partial without faking linkback', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const testEnv = createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults })
    const seeded = await captureAndProject({
      fixture: noteFixture as CanonicalPipelineCaptureInput,
      suffix: 'mixed-linkback',
      memoryType: 'episodic',
      testEnv,
      tmk,
    })

    replaceRecallResults(recallResults, [
      {
        id: 'semantic-linked-result',
        document_id: seeded.engineDocumentId,
        text: 'Follow up with two open questions tomorrow.',
        score: 0.88,
        metadata: { source: 'mcp_retain', domain: 'general' },
      },
      {
        id: 'semantic-external-result',
        document_id: 'external-only-document',
        text: 'A local-only semantic memory without canonical capture metadata.',
        score: 0.42,
        metadata: { source: 'local_notes', domain: 'general' },
      },
    ])

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'What do I know about tomorrow?',
      mode: 'semantic',
      limit: 5,
    })

    expect(result.status).toBe('partial')
    expect(result.items[0]?.provenance?.captureId).toBe(seeded.captureId)
    expect(result.items[1]?.captureId).toBeNull()
    expect(result.items[1]?.documentId).toBeNull()
    expect(result.items[1]?.provenance?.sourceSystem).toBe('local_notes')
    expect(result.items[1]?.semanticStatus?.ready).toBe(false)
  })

  it('keeps not-yet-projected captures out of semantic mode while raw search still finds them', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const testEnv = createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults })
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture({
      ...(noteFixture as CanonicalPipelineCaptureInput),
      body: `${(noteFixture as CanonicalPipelineCaptureInput).body} PendingSemanticOnly`,
    }, TENANT_A, 'pending-semantic', tmk)
    await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_A)
    sendSpy.mockRestore()

    const semantic = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'PendingSemanticOnly',
      mode: 'semantic',
      limit: 3,
    })
    const raw = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'PendingSemanticOnly',
      limit: 3,
    })

    expect(semantic.mode).toBe('semantic')
    expect(semantic.items).toHaveLength(0)
    expect(raw.mode).toBe('raw')
    expect(raw.items[0]?.captureId).toBeTruthy()
  })

  it('extends memory_status with truthful semantic readiness and engine linkback fields', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const testEnv = createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults })
    const seeded = await captureAndProject({
      fixture: noteFixture as CanonicalPipelineCaptureInput,
      suffix: 'status-semantic',
      memoryType: 'episodic',
      testEnv,
      tmk,
    })

    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: seeded.operationId },
      testEnv,
      TENANT_A,
    ) as CanonicalMemoryStatusResult
    const hindsightProjection = status.projections.find(item => item.kind === 'hindsight')

    expect(hindsightProjection?.resultStatus).toBe('completed')
    expect(hindsightProjection?.engineDocumentId).toBe(seeded.engineDocumentId)
    expect(hindsightProjection?.engineOperationId).toContain('op-')
    expect(hindsightProjection?.semanticReady).toBe(true)
    expect(status.compatibility?.status).toBe('retained')
  })

  it('returns a truthful unavailable semantic result when the engine recall call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const testEnv = createHindsightTestEnv({
      capture,
      failRecall: true,
      operationStatus: 'completed',
      recallResults,
    })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tmk), 'search_memory', {
      query: 'Anything pending?',
      mode: 'semantic',
      limit: 3,
    })

    expect(result.mode).toBe('semantic')
    expect(result.status).toBe('unavailable')
    expect(result.items).toEqual([])
  })
})
