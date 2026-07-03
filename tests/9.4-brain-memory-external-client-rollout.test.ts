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
import { createHindsightTestEnv, type HindsightRecallRow } from './support/hindsight-test-env'
import { seedHistoricalHindsightProjection } from './support/historical-hindsight-seed'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { getCanonicalMemoryStore } from '../src/services/canonical-postgres'

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

function createRuntimeEnvWithRecall(recallResults: HindsightRecallRow[]): typeof env {
  const { testEnv } = createGraphitiContainerTestEnv()
  return {
    ...createHindsightTestEnv({ recallResults, operationStatus: 'completed' }),
    GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: testEnv.GRAPHITI,
  } as typeof env
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
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const explicit = await callTool<Record<string, string | Record<string, unknown>>>(registry, 'capture_memory', {
      content: 'Decision: keep Northgate Studio focused on durable factual recall.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Codex',
    })
    const sessionSummary = await callTool<Record<string, string | Record<string, unknown>>>(registry, 'capture_memory', {
      content: 'Session summary: reviewed the open loops and next actions for Northgate Studio.',
      scope: 'general',
      capture_mode: 'session_summary',
      client_name: 'Codex',
      session_id: 'trace-99',
    })
    const artifact = await callTool<Record<string, string | Record<string, unknown>>>(registry, 'capture_memory', {
      content: 'Artifact summary: the rollout spec is the durable meaning worth recalling.',
      scope: 'research',
      capture_mode: 'artifact',
      client_name: 'Codex',
      artifact_ref: 'specs/active/9.9-tenant-memory-trace.md',
      artifact_filename: '9.9-tenant-memory-trace.md',
    })

    // No caller ever set memory_type, so resolveBrainMemoryType() falls back
    // to 'episodic' for every capture mode; that surfaces as the 'episode'
    // memory class on the governance receipt returned by the canonical
    // pipeline (write path severed for Hindsight, HAETSAL_MISSION.md Phase 1).
    for (const result of [explicit, sessionSummary, artifact]) {
      const governance = result.governance as Record<string, unknown>
      expect(governance.memoryClass).toBe('episode')
    }
    expect((explicit.governance as Record<string, unknown>).authorKind).toBe('external_client')
    expect((explicit.governance as Record<string, unknown>).trustState).toBe('evidence')
    expect((explicit.governance as Record<string, unknown>).usePolicy).toBe('can_use_as_evidence')
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

  it('gives repeated brain-memory captures distinct canonical capture identities', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const first = await callTool<Record<string, string | Record<string, unknown>>>(registry, 'capture_memory', {
      content: 'Decision: first explicit brain-memory capture for unique projection identity.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })
    const second = await callTool<Record<string, string | Record<string, unknown>>>(registry, 'capture_memory', {
      content: 'Decision: second explicit brain-memory capture should stay isolated per capture.',
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
      store.getLatestProjectionResultForOperation(TENANT_ID, String(first.canonical_operation_id), 'graphiti'),
      store.getLatestProjectionResultForOperation(TENANT_ID, String(second.canonical_operation_id), 'graphiti'),
    ])
    expect(first.canonical_capture_id).not.toBe(second.canonical_capture_id)
    expect(first.canonical_operation_id).not.toBe(second.canonical_operation_id)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row?.result_status === 'completed')).toBe(true)
  })

  it('resolves semantic linkback to the correct historical capture using canonical metadata', async () => {
    // Historical Hindsight projection: simulates a capture that was projected
    // to Hindsight before the write path was severed (mission Phase 1). The
    // pipeline can no longer produce these for brain-memory captures, so this
    // is seeded directly to exercise linkback resolution for the
    // mcp:memory_write source system.
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnvWithRecall(recallResults)

    const first = await seedHistoricalHindsightProjection(testEnv, {
      tenantId: TENANT_ID,
      sourceSystem: 'mcp:memory_write',
      sourceRef: 'brain-memory:explicit:first',
      scope: 'general',
      title: null,
      body: 'Decision: first semantic linkback candidate for isolated hindsight document.',
      tmk,
    })
    const second = await seedHistoricalHindsightProjection(testEnv, {
      tenantId: TENANT_ID,
      sourceSystem: 'mcp:memory_write',
      sourceRef: 'brain-memory:explicit:second',
      scope: 'general',
      title: null,
      body: 'Decision: second semantic linkback candidate should be selected by canonical metadata.',
      tmk,
    })

    recallResults.splice(0, recallResults.length, {
      id: 'brain-memory-semantic-result',
      document_id: second.engineDocumentId,
      text: 'Second semantic linkback candidate should be selected by canonical metadata.',
      score: 0.93,
      tags: [`tenant:${TENANT_ID}`],
      metadata: {
        source: 'mcp:memory_write',
        domain: 'general',
        canonical_capture_id: second.captureId,
        canonical_document_id: second.documentId,
        canonical_operation_id: second.operationId,
      },
    })

    const registry = createToolRegistry(testEnv, tmk)
    const semantic = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'selected by canonical metadata',
      mode: 'semantic',
      limit: 3,
    })

    expect(semantic.status).toBe('ok')
    expect(semantic.items[0]?.captureId).toBe(second.captureId)
    expect(semantic.items[0]?.documentId).toBe(second.documentId)
    expect(semantic.items[0]?.provenance?.canonicalOperationId).toBe(second.operationId)
    expect(semantic.items[0]?.captureId).not.toBe(first.captureId)
  })

  it('eagerly dispatches graphiti projection for brain-memory captures so status is completed immediately', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const registry = createToolRegistry(testEnv, tmk)

    const explicit = await callTool<Record<string, string | Record<string, unknown>>>(registry, 'capture_memory', {
      content: 'Decision: Alder Port depends on Nimbus Rail for freight movement.',
      scope: 'general',
      capture_mode: 'explicit',
      client_name: 'Claude Code',
    })

    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_ID, operationId: String(explicit.canonical_operation_id) },
      testEnv,
      TENANT_ID,
    )

    expect(status.operation.status).toBe('completed')
    expect(status.graph?.status).toBe('projected')
    expect((explicit.governance as Record<string, unknown>).authorKind).toBe('external_client')
    expect((explicit.governance as Record<string, unknown>).trustState).toBe('evidence')
    expect((explicit.governance as Record<string, unknown>).usePolicy).toBe('can_use_as_evidence')
  })
})
