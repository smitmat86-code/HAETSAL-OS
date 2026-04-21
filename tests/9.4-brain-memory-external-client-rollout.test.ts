import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  CanonicalDocumentResult,
  CanonicalMemoryStatusResult,
  CanonicalRecentResult,
  CanonicalSearchResult,
} from '../src/types/canonical-memory-query'
import { BRAIN_MEMORY_SURFACE_PROFILE, EXTERNAL_CLIENT_CAPTURE_PATTERNS } from '../src/services/external-client-memory'
import { BRAIN_MEMORY_TOOL_NAMES } from '../src/tools/brain-memory-surface'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv, type HindsightCaptureState, type HindsightRecallRow } from './support/hindsight-test-env'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { buildExpectedHindsightDocumentId } from '../src/services/canonical-hindsight-projection-payload'
import { buildHindsightBankProvisioningSpec } from '../src/services/bootstrap/hindsight-bank-spec'
import { normalizeExternalClientCapture } from '../src/services/external-client-memory'
import { buildHindsightRetainRequest } from '../src/services/ingestion/retain-request'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-brain-memory-94-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`brain-memory-94-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('brain-memory-94-salt'),
    info: new TextEncoder().encode('brain-memory-94-info'),
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

function makeEnvWithHindsightStub() {
  const { testEnv } = createGraphitiContainerTestEnv()
  return {
    ...env,
    GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: testEnv.GRAPHITI,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname) || /^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as { async?: boolean }
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: body.async ?? false,
            operation_id: body.async ? `op-${crypto.randomUUID()}` : undefined,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    },
  } as unknown as typeof env
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

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown = {}): Promise<T> {
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

beforeAll(async () => { await ensureTenantWithKek() })
beforeEach(() => { vi.restoreAllMocks() })

describe('9.4 brain-memory external client rollout', () => {
  it('captures explicit, session-summary, and artifact-linked memories through capture_memory and preserves rollout attribution on reads', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const explicit = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: keep brain-memory as the first MCP-native rollout surface.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Codex',
      title: 'Rollout decision',
      source_ref: 'decision-94',
    })
    const sessionSummary = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Session summary: extended the canonical memory surface for client-safe capture modes and left source-read actions out of scope.',
      scope: 'general',
      capture_mode: 'session_summary',
      client_name: 'Claude Code',
      session_id: 'close-94',
    })
    const artifact = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Artifact summary: the 9.4 rollout spec defines explicit capture, session-close summary capture, and artifact-linked capture as the first durable patterns.',
      scope: 'research',
      capture_mode: 'artifact',
      client_name: 'Cursor',
      title: '9.4 rollout spec',
      artifact_ref: 'specs/active/9.4-brain-memory-external-client-rollout.md',
      artifact_filename: '9.4-brain-memory-external-client-rollout.md',
      artifact_media_type: 'text/markdown',
      artifact_byte_length: 4096,
    })

    expect(explicit.surface).toBe('brain-memory')
    expect(explicit.capture_mode).toBe('explicit')
    expect(explicit.provenance).toBe('user_authored')
    expect(explicit.source_system).toBe('mcp:memory_write')
    expect(sessionSummary.capture_mode).toBe('session_summary')
    expect(sessionSummary.provenance).toBe('agent_authored')
    expect(artifact.capture_mode).toBe('artifact')
    expect(artifact.profile).toEqual(BRAIN_MEMORY_SURFACE_PROFILE)

    const search = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'session-close summary capture',
      limit: 5,
    })
    const recent = await callTool<CanonicalRecentResult>(registry, 'get_recent_memories', { limit: 5 })
    const document = await callTool<CanonicalDocumentResult>(registry, 'get_document', {
      document_id: artifact.canonical_document_id,
    })
    const status = await callTool<CanonicalMemoryStatusResult>(registry, 'memory_status', {
      operation_id: sessionSummary.canonical_operation_id,
    })

    expect(search.items[0]?.brainMemory?.captureMode).toBe('artifact')
    expect(search.items[0]?.brainMemory?.clientName).toBe('Cursor')
    expect(search.items[0]?.brainMemory?.provenance).toBe('agent_authored')
    expect(recent.items.some((item) => item.brainMemory?.captureMode === 'explicit' && item.brainMemory?.clientName === 'Codex')).toBe(true)
    expect(recent.items.some((item) => item.brainMemory?.captureMode === 'session_summary' && item.brainMemory?.sessionId === 'close-94')).toBe(true)
    expect(document.brainMemory?.captureMode).toBe('artifact')
    expect(document.artifact?.storageKind).toBe('reference')
    expect(document.artifact?.storageKey).toBe('specs/active/9.4-brain-memory-external-client-rollout.md')
    expect(status.sourceSystem).toBe('mcp:memory_write')
    expect(status.brainMemory?.captureMode).toBe('session_summary')
    expect(status.brainMemory?.sessionId).toBe('close-94')
  })

  it('keeps brain-memory scoped to memory-only capabilities and reuses the canonical tool family', async () => {
    const toolNames = new Set(BRAIN_MEMORY_TOOL_NAMES)

    expect(BRAIN_MEMORY_SURFACE_PROFILE.canReadSources).toBe(false)
    expect(BRAIN_MEMORY_SURFACE_PROFILE.canMutateSources).toBe(false)
    expect(BRAIN_MEMORY_SURFACE_PROFILE.recommendedDefaultCaptureMode).toBe('session_summary')
    expect(BRAIN_MEMORY_SURFACE_PROFILE.rejectsFullTranscriptDefault).toBe(true)
    expect(EXTERNAL_CLIENT_CAPTURE_PATTERNS.map((pattern) => pattern.id)).toEqual([
      'explicit',
      'session_summary',
      'artifact',
    ])
    expect(BRAIN_MEMORY_SURFACE_PROFILE.writeToolNames.every((name) => toolNames.has(name))).toBe(true)
    expect(BRAIN_MEMORY_SURFACE_PROFILE.readToolNames.every((name) => toolNames.has(name))).toBe(true)
    expect(toolNames.has('capture_memory')).toBe(true)
    expect(toolNames.has('search_memory')).toBe(true)
    expect(toolNames.has('get_document')).toBe(true)
    expect(toolNames.has('memory_status')).toBe(true)
    expect(toolNames.has('memory_stats')).toBe(true)
    expect(toolNames.has('brain_v1_act_send_message')).toBe(false)
    expect(toolNames.has('gmail.read_thread')).toBe(false)
  })

  it('defaults brain-memory captures to episodic unless the caller explicitly overrides memory_type', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    const retainMetadata: Array<Record<string, string>> = []
    const originalFetch = testEnv.HINDSIGHT.fetch.bind(testEnv.HINDSIGHT)
    vi.spyOn(testEnv.HINDSIGHT, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
      if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
        const request = input instanceof Request ? input : new Request(input.toString(), init)
        const body = await request.clone().json() as { items?: Array<{ metadata?: Record<string, string> }> }
        retainMetadata.push(body.items?.[0]?.metadata ?? {})
      }
      return originalFetch(input, init)
    })
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: keep Northgate Studio focused on durable factual recall.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Codex',
    })
    await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Session summary: reviewed the open loops and next actions for Northgate Studio.',
      scope: 'general',
      capture_mode: 'session_summary',
      client_name: 'Codex',
      session_id: 'trace-99',
    })
    await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Artifact summary: the rollout spec is the durable meaning worth recalling.',
      scope: 'research',
      capture_mode: 'artifact',
      client_name: 'Codex',
      artifact_ref: 'specs/active/9.9-tenant-memory-trace.md',
      artifact_filename: '9.9-tenant-memory-trace.md',
    })

    expect(retainMetadata).toHaveLength(3)
    expect(retainMetadata[0]?.app_memory_type).toBe('episodic')
    expect(retainMetadata[1]?.app_memory_type).toBe('episodic')
    expect(retainMetadata[2]?.app_memory_type).toBe('episodic')
    const explicitBrainMemory = JSON.parse(retainMetadata[0]?.brain_memory ?? '{}') as Record<string, unknown>
    expect(explicitBrainMemory.client_name).toBeUndefined()
    expect(explicitBrainMemory.capture_mode).toBe('explicit')
    expect(explicitBrainMemory.provenance).toBe('user_authored')
  })

  it('defaults capture_memory to the brain-memory explicit rollout path when capture_mode is omitted', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const capture = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: default brain-memory capture should still normalize to explicit mode.',
      scope: 'general',
    })

    const status = await callTool<CanonicalMemoryStatusResult>(registry, 'memory_status', {
      operation_id: capture.canonical_operation_id,
    })

    expect(capture.source_system).toBe('mcp:memory_write')
    expect(capture.capture_mode).toBe('explicit')
    expect(capture.provenance).toBe('user_authored')
    expect(status.sourceSystem).toBe('mcp:memory_write')
    expect(status.brainMemory?.captureMode).toBe('explicit')
  })

  it('uses per-capture hindsight documents for repeated brain-memory captures', async () => {
    const tmk = await deriveTestTmk()
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ capture, operationStatus: 'completed' }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const first = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: first explicit brain-memory capture for unique projection identity.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })
    const second = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: second explicit brain-memory capture should stay isolated in hindsight.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })

    const messages = sendSpy.mock.calls.map((call) => call[0] as { tenantId: string; payload: Record<string, unknown> })
    for (const message of messages) {
      await processDispatch(message, testEnv)
    }

    const store = getCanonicalMemoryStore(testEnv)
    const rows = await Promise.all([
      store.getLatestProjectionResultForOperation(TENANT_ID, String(first.canonical_operation_id), 'hindsight'),
      store.getLatestProjectionResultForOperation(TENANT_ID, String(second.canonical_operation_id), 'hindsight'),
    ])
    expect(capture.retainCount).toBe(2)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row?.result_status === 'completed')).toBe(true)
    expect(rows[0]?.engine_document_id).toBeTruthy()
    expect(rows[1]?.engine_document_id).toBeTruthy()
    expect(rows[0]?.engine_document_id).not.toBe(rows[1]?.engine_document_id)
    expect(rows[0]?.engine_operation_id).toBeTruthy()
    expect(rows[1]?.engine_operation_id).toBeTruthy()
    expect(rows[0]?.engine_operation_id).not.toBe(rows[1]?.engine_operation_id)
    expect(rows[0]?.engine_document_id).toContain(String(first.canonical_capture_id))
    expect(rows[1]?.engine_document_id).toContain(String(second.canonical_capture_id))
  })

  it('resolves semantic linkback to the correct capture using canonical metadata', async () => {
    const tmk = await deriveTestTmk()
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const recallResults: HindsightRecallRow[] = []
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const first = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: first semantic linkback candidate for isolated hindsight document.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })
    const second = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: 'Decision: second semantic linkback candidate should be selected by canonical metadata.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })

    const messages = sendSpy.mock.calls.map((call) => call[0] as { tenantId: string; payload: Record<string, unknown> })
    for (const message of messages) {
      await processDispatch(message, testEnv)
    }

    const secondRow = await getCanonicalMemoryStore(testEnv)
      .getLatestProjectionResultForOperation(TENANT_ID, String(second.canonical_operation_id), 'hindsight')

    recallResults.splice(0, recallResults.length, {
      id: 'brain-memory-semantic-result',
      document_id: secondRow!.engine_document_id!,
      text: 'Second semantic linkback candidate should be selected by canonical metadata.',
      score: 0.93,
      metadata: {
        source: 'mcp:memory_write',
        domain: 'general',
        canonical_capture_id: second.canonical_capture_id,
        canonical_document_id: second.canonical_document_id,
        canonical_operation_id: second.canonical_operation_id,
      },
    })

    const semantic = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'selected by canonical metadata',
      mode: 'semantic',
      limit: 3,
    })

    expect(semantic.status).toBe('ok')
    expect(semantic.items[0]?.captureId).toBe(second.canonical_capture_id)
    expect(semantic.items[0]?.documentId).toBe(second.canonical_document_id)
    expect(semantic.items[0]?.provenance?.canonicalOperationId).toBe(second.canonical_operation_id)
    expect(semantic.items[0]?.captureId).not.toBe(first.canonical_capture_id)
  })

  it('eagerly dispatches async hindsight retain for brain-memory captures and becomes semantically ready for meaningful natural-language facts', async () => {
    const tmk = await deriveTestTmk()
    const capture: HindsightCaptureState = { retainCount: 0, operationIds: [] }
    const recallResults: HindsightRecallRow[] = []
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ capture, operationStatus: 'completed', recallResults }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const semanticFact = 'Decision: Alder Port depends on Nimbus Rail for freight movement.'
    const explicit = await callTool<Record<string, string | object>>(registry, 'capture_memory', {
      content: semanticFact,
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })

    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
    await processDispatch(message, testEnv)

    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_ID, operationId: String(explicit.canonical_operation_id) },
      testEnv,
      TENANT_ID,
    )
    const hindsight = status.projections.find((item) => item.kind === 'hindsight')
    recallResults.splice(0, recallResults.length, {
      id: 'brain-memory-freshness-result',
      document_id: hindsight?.engineDocumentId,
      text: 'Alder Port depends on Nimbus Rail as per a fresh brain-memory decision.',
      score: 0.99,
      metadata: {
        canonical_capture_id: String(explicit.canonical_capture_id),
        canonical_document_id: String(explicit.canonical_document_id),
        canonical_operation_id: String(explicit.canonical_operation_id),
        source: 'mcp:memory_write',
        domain: 'general',
      },
    })
    const semantic = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'what does Alder Port depend on',
      mode: 'semantic',
      limit: 3,
    })

    expect(capture.retainCount).toBe(1)
    expect(status.operation.status).toBe('completed')
    expect(hindsight?.status).toBe('completed')
    expect(hindsight?.resultStatus).toBe('completed')
    expect(hindsight?.engineDocumentId).toContain(String(explicit.canonical_capture_id))
    expect(hindsight?.engineOperationId).toContain('op-')
    expect(hindsight?.semanticReady).toBe(true)
    expect(status.compatibility?.status).toBe('retained')
    expect(semantic.status).toBe('ok')
    expect(semantic.items[0]?.captureId).toBe(String(explicit.canonical_capture_id))
    expect(semantic.items[0]?.provenance?.canonicalOperationId).toBe(String(explicit.canonical_operation_id))
  })

  it('plans per-capture hindsight document ids consistently for brain-memory captures', () => {
    const captureId = crypto.randomUUID()
    const normalized = normalizeExternalClientCapture({
      content: 'Decision: durable dependency facts should stay isolated per capture.',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
      source_ref: 'same-logical-locator',
    })

    const documentId = buildExpectedHindsightDocumentId(
      TENANT_ID,
      normalized.sourceSystem,
      normalized.sourceRef,
      captureId,
    )

    expect(documentId).toContain(captureId)
    expect(documentId).not.toContain('same-logical-locator')
  })

  it('keeps hindsight retain context terse and stable for explicit brain-memory writes', () => {
    const normalized = normalizeExternalClientCapture({
      content: 'Decision: Northgate Studio depends on Meridian Stack for delivery planning.',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })

    const { request } = buildHindsightRetainRequest({
      tenantId: TENANT_ID,
      source: normalized.sourceSystem,
      sourceRef: normalized.sourceRef,
      content: 'Decision: Northgate Studio depends on Meridian Stack for delivery planning.',
      occurredAt: Date.now(),
      memoryType: 'episodic',
      domain: 'general',
      provenance: normalized.provenance,
      metadata: normalized.metadata,
    }, 'dedup-hash', 'episodic', 'general', 3, true)

    const context = request.items[0]?.context ?? ''
    expect(context).toContain('source=mcp:memory_write')
    expect(context).toContain('provenance=user_authored')
    expect(context).toContain('domain=general')
    expect(context).toContain('capture_mode=explicit')
    expect(context).toContain('intent=retain_durable_fact')
    expect(context).toContain('pattern=durable_dependency')
    expect(context).toContain('subject=Northgate_Studio')
    expect(context).toContain('object=Meridian_Stack')
  })

  it('keeps the hindsight bank mission focused on durable long-horizon patterns', () => {
    const spec = buildHindsightBankProvisioningSpec('haetsalos.specialdarksystems.com', 'test-secret')
    const retainMission = String(spec.bankConfig.retain_mission)
    const observationsMission = String(spec.bankConfig.observations_mission)

    expect(retainMission).toContain('career decisions and professional milestones')
    expect(retainMission).toContain('durable dependencies')
    expect(retainMission).toContain('lasting dependency')
    expect(observationsMission).toContain('professional trajectory')
    expect(observationsMission).toContain('domain expertise')
  })
})
