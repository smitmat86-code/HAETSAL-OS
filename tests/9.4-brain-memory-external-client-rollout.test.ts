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
  return {
    ...env,
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
})
