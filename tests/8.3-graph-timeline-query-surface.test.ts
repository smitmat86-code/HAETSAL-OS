import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { EntityTimelineResult, TraceRelationshipResult } from '../src/types/canonical-graph-query'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv } from './support/hindsight-test-env'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_PREFIX = `test-tenant-graph-query-83-${SUITE_ID}`
const partnershipFixture: CanonicalPipelineCaptureInput = {
  tenantId: 'test-tenant-canonical',
  sourceSystem: 'mcp_retain',
  sourceRef: 'partnership-001',
  scope: 'general',
  title: 'Partner update',
  body: 'Northwind Labs partnered with Blue River Studio on 2026-04-16.',
  capturedAt: Date.UTC(2026, 3, 20),
}
const meetingFixture: CanonicalPipelineCaptureInput = {
  tenantId: 'test-tenant-canonical',
  sourceSystem: 'mcp_retain',
  sourceRef: 'meeting-001',
  scope: 'general',
  title: 'Meeting update',
  body: 'Ava Stone met with Ben Ortiz on 2026-04-15.',
  capturedAt: Date.UTC(2026, 3, 20),
}
const dependencyFixture: CanonicalPipelineCaptureInput = {
  tenantId: 'test-tenant-canonical',
  sourceSystem: 'mcp_retain',
  sourceRef: 'dependency-001',
  scope: 'general',
  title: 'Dependency update',
  body: 'Project Atlas depends on Beacon API.',
  capturedAt: Date.UTC(2026, 3, 21),
}

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`graph-query-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('graph-query-salt'),
    info: new TextEncoder().encode('graph-query-info'),
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

function createToolRegistry(
  testEnv: typeof env,
  tenantId: string,
  tmk: CryptoKey | null,
): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = { tool(name: string, _description: string, _shape: object, handler: ToolHandler) { handlers.set(name, handler) } } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => tenantId,
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
  tenantId: string
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  memoryType: 'episodic' | 'semantic' | 'world'
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<void> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, args.tenantId, args.suffix, args.tmk)
  await captureThroughCanonicalPipeline({ ...input, compatibilityMode: 'off', memoryType: args.memoryType }, args.testEnv, args.tenantId)
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processCanonicalProjectionDispatch(message.tenantId, { ...message.payload, projectionKinds: ['graphiti'] }, args.testEnv)
  sendSpy.mockRestore()
}

beforeEach(() => { vi.restoreAllMocks() })

describe('8.3 graph and timeline query surface', () => {
  it('traces a direct relationship through the canonical graph surface with provenance linkback', async () => {
    const tenantId = `${TENANT_PREFIX}-relationship`
    const tmk = await deriveTestTmk()
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ recallResults: [], operationStatus: 'completed' }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    await ensureTenantWithKek(tenantId)
    await captureAndProject({ tenantId, fixture: partnershipFixture, suffix: 'relationship', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<TraceRelationshipResult>(createToolRegistry(testEnv, tenantId, tmk), 'trace_relationship', {
      from: 'Northwind Labs', to: 'Blue River Studio', relation: 'partnered_with', limit: 5,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.from.key).toBe('canonical://organizations/northwind-labs')
    expect(result.items[0]?.to.key).toBe('canonical://organizations/blue-river-studio')
    expect(result.items[0]?.provenance.projectionKind).toBe('graphiti')
    expect(result.items[0]?.provenance.captureId).toBeTruthy()
    expect(result.items[0]?.provenance.graphRef).toContain('graphiti://edges/')
  })

  it('returns a chronologically ordered timeline for a dated body-derived entity relation', async () => {
    const tenantId = `${TENANT_PREFIX}-timeline`
    const tmk = await deriveTestTmk()
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ recallResults: [], operationStatus: 'completed' }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    await ensureTenantWithKek(tenantId)
    await captureAndProject({ tenantId, fixture: meetingFixture, suffix: 'timeline-meeting', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<EntityTimelineResult>(createToolRegistry(testEnv, tenantId, tmk), 'get_entity_timeline', {
      entity: 'Ava Stone', limit: 5,
    })

    expect(result.entityKey).toBe('canonical://people/ava-stone')
    expect(result.items[0]?.title).toBe('Meeting update')
    expect(result.items[0]?.relation).toBe('met_with')
    expect(result.items[0]?.capturedAt).toBe(Date.UTC(2026, 3, 15))
  })

  it('reuses search_memory as an explicit graph-backed composed retrieval path', async () => {
    const tenantId = `${TENANT_PREFIX}-graph-search`
    const tmk = await deriveTestTmk()
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ recallResults: [], operationStatus: 'completed' }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    await ensureTenantWithKek(tenantId)
    await captureAndProject({ tenantId, fixture: dependencyFixture, suffix: 'graph-search', memoryType: 'episodic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tenantId, tmk), 'search_memory', {
      query: 'Project Atlas', mode: 'graph', limit: 5,
    })

    expect(result.mode).toBe('graph')
    expect(result.status).toBe('ok')
    expect(result.items[0]?.mode).toBe('graph')
    expect(result.items[0]?.graphContext?.entityLabel).toBe('Project Atlas')
    expect(result.items[0]?.provenance?.projectionKind).toBe('graphiti')
    expect(result.items.some(item => item.preview.includes('Beacon Api'))).toBe(true)
  })

  it('keeps default canonical search behavior stable unless graph mode is requested explicitly', async () => {
    const tenantId = `${TENANT_PREFIX}-default-search`
    const tmk = await deriveTestTmk()
    const { testEnv: graphEnv } = createGraphitiContainerTestEnv()
    const testEnv = {
      ...createHindsightTestEnv({ recallResults: [], operationStatus: 'completed' }),
      GRAPHITI_RUNTIME_MODE: graphEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: graphEnv.GRAPHITI,
    } as typeof env
    await ensureTenantWithKek(tenantId)
    await captureAndProject({ tenantId, fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'default-search', memoryType: 'semantic', testEnv, tmk })

    const result = await callTool<CanonicalSearchResult>(createToolRegistry(testEnv, tenantId, tmk), 'search_memory', {
      query: 'User', limit: 5,
    })

    expect(result.mode).toBe('raw')
    expect(result.items[0]?.title).toBe('Conversation recap')
  })
})
