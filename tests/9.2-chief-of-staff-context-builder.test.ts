import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { AgentContextBundle } from '../src/types/chief-of-staff-context'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createHindsightTestEnv, type HindsightCaptureState, type HindsightRecallRow } from './support/hindsight-test-env'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }
type SeededCapture = { captureId: string; documentId: string; operationId: string; engineDocumentId: string }

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-context-92-${SUITE_ID}`
const projectNote: CanonicalPipelineCaptureInput = { tenantId: TENANT_ID, sourceSystem: 'mcp_retain', sourceRef: 'launch-note', scope: 'general', title: 'Launch plan', body: 'Launch plan now runs through three milestones. Risk: the operations checklist still needs an owner before launch.', capturedAt: 1760280000000 }
const projectConversation: CanonicalPipelineCaptureInput = { tenantId: TENANT_ID, sourceSystem: 'mcp_memory_write', sourceRef: 'launch-conversation', scope: 'general', title: 'Launch plan', body: 'User: We removed the optional work from the critical path.\nAssistant: Captured. Recent change: only the three launch milestones remain, and the checklist owner is still unresolved.', capturedAt: 1760366400000 }
const sparseProject: CanonicalPipelineCaptureInput = { tenantId: TENANT_ID, sourceSystem: 'mcp_retain', sourceRef: 'quiet-project', scope: 'general', title: 'Quiet scope', body: 'Quiet scope has one clear next step and one unresolved follow-up.', capturedAt: 1760452800000 }

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`context-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('context-salt'), info: new TextEncoder().encode('context-info') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function ensureTenantWithKek(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(`INSERT OR IGNORE INTO tenants (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at) VALUES (?, ?, ?, 'us', 'sms', ?, ?)`).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()
  await env.KV_SESSION.put(`cron_kek:${TENANT_ID}`, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), { expirationTtl: 60 * 60 * 24 })
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`).bind(now + (24 * 60 * 60 * 1000), now, TENANT_ID).run()
}

async function encryptFixture(fixture: CanonicalPipelineCaptureInput, suffix: string, tmk: CryptoKey): Promise<CanonicalPipelineCaptureInput> {
  return { ...fixture, tenantId: TENANT_ID, sourceRef: `${fixture.sourceRef}-${suffix}`, bodyEncrypted: await encryptContentForArchive(fixture.body, tmk) }
}

function createRuntimeEnv(state: { recallResults: HindsightRecallRow[]; capture: HindsightCaptureState; graph?: boolean }): typeof env {
  return { ...createHindsightTestEnv({ capture: state.capture, operationStatus: 'completed', recallResults: state.recallResults }), ...(state.graph === false ? {} : { GRAPHITI_API_URL: 'https://graphiti.internal', GRAPHITI_API_TOKEN: 'graphiti-test-token' }) } as typeof env
}

function createToolRegistry(testEnv: typeof env, tmk: CryptoKey): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = { tool(name: string, _description: string, _shape: object, handler: ToolHandler) { handlers.set(name, handler) } } as unknown as McpServer
  registerCanonicalMemoryTools(server, { getEnv: () => testEnv, getTenantId: () => TENANT_ID, getTmk: () => tmk, getExecutionContext: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }) })
  return { handlers, pending }
}

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
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
      ...(body.plan.entities as Array<Record<string, unknown>>).map((entity, index: number) => ({ canonicalKey: entity.canonicalKey, graphRef: `graphiti://entities/${body.captureId}-${index}`, graphKind: 'entity' })),
      ...(body.plan.edges as Array<Record<string, unknown>>).map((edge, index: number) => ({ canonicalKey: edge.canonicalKey, graphRef: `graphiti://edges/${body.captureId}-${index}`, graphKind: 'edge' })),
    ],
  }
}

async function captureAndProject(args: { fixture: CanonicalPipelineCaptureInput; suffix: string; memoryType: 'episodic' | 'semantic' | 'world'; testEnv: typeof env; tmk: CryptoKey }): Promise<SeededCapture> {
  const originalFetch = globalThis.fetch
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input)
    if (!url.includes('graphiti.internal')) return originalFetch(input, init)
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}'))) as Record<string, any>
    return new Response(JSON.stringify(buildCompletedGraphResponse(body)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const input = await encryptFixture(args.fixture, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({ ...input, memoryType: args.memoryType, compatibilityMode: 'current_hindsight' }, args.testEnv, TENANT_ID)
  const pending: Promise<unknown>[] = []
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, args.testEnv, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } })
  await Promise.allSettled(pending)
  sendSpy.mockRestore()
  vi.restoreAllMocks()
  const projection = await args.testEnv.D1_US.prepare(`SELECT r.engine_document_id FROM canonical_projection_results r INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight' ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC LIMIT 1`).bind(TENANT_ID, result.capture.operationId).first<{ engine_document_id: string }>()
  return { captureId: result.capture.captureId, documentId: result.capture.documentId, operationId: result.capture.operationId, engineDocumentId: projection!.engine_document_id }
}

function expectPublicBundleShape(bundle: AgentContextBundle): void {
  expect(Object.keys(bundle).sort()).toEqual(['agent', 'confidence', 'evidence', 'followUpQuestions', 'gaps', 'highlights', 'intent', 'openLoops', 'recentChanges', 'relationships', 'risks', 'scope', 'sources', 'summary', 'target', 'timeline'].sort())
  expect(JSON.stringify(bundle)).not.toContain('engineDocumentId')
  expect(JSON.stringify(bundle)).not.toContain('engineOperationId')
}

beforeAll(async () => { await ensureTenantWithKek() })
beforeEach(() => { vi.restoreAllMocks() })

describe('9.2 chief-of-staff context builder', () => {
  it('assembles a person bundle with relationship, provenance, and open-loop signals', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults, capture: { retainCount: 0, operationIds: [] } })
    const seeded = await captureAndProject({ fixture: conversationFixture as CanonicalPipelineCaptureInput, suffix: 'person', memoryType: 'semantic', testEnv, tmk })
    recallResults.splice(0, recallResults.length, { document_id: seeded.engineDocumentId, text: 'The operations checklist still needs an owner before the next meeting.', score: 0.96, metadata: { source: 'mcp_memory_write', domain: 'general' } })

    const bundle = await callTool<AgentContextBundle>(createToolRegistry(testEnv, tmk), 'prepare_context_for_agent', {
      agent: 'chief_of_staff', intent: 'person', target: 'User', limit: 4,
    })

    expect(bundle.intent).toBe('person')
    expect(bundle.relationships[0]).toContain('User')
    expect(bundle.openLoops[0]).toContain('checklist')
    expect(bundle.sources.some((source) => source.mode === 'semantic' && source.documentId === seeded.documentId)).toBe(true)
    expect(bundle.evidence.some((block) => block.mode === 'composed')).toBe(true)
    expectPublicBundleShape(bundle)
  })

  it('assembles a project bundle with summary, risks, recent changes, and provenance', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults, capture: { retainCount: 0, operationIds: [] } })
    await captureAndProject({ fixture: projectNote, suffix: 'project-note', memoryType: 'episodic', testEnv, tmk })
    const seeded = await captureAndProject({ fixture: projectConversation, suffix: 'project-conversation', memoryType: 'semantic', testEnv, tmk })
    recallResults.splice(0, recallResults.length, { document_id: seeded.engineDocumentId, text: 'Launch plan is down to three milestones, optional work left the critical path, and the checklist owner is still unresolved.', score: 0.95, metadata: { source: 'mcp_memory_write', domain: 'general' } })

    const bundle = await callTool<AgentContextBundle>(createToolRegistry(testEnv, tmk), 'prepare_context_for_agent', {
      agent: 'chief_of_staff', intent: 'project', target: 'Launch plan', limit: 4,
    })

    expect(bundle.intent).toBe('project')
    expect(bundle.summary).toContain('Launch plan')
    expect(bundle.recentChanges.some((item) => item.includes('three milestones'))).toBe(true)
    expect(bundle.risks.some((item) => item.includes('owner'))).toBe(true)
    expect(bundle.timeline.length).toBeGreaterThan(0)
    expect(bundle.sources.some((source) => source.projectionRef || source.graphRef)).toBe(true)
    expectPublicBundleShape(bundle)
  })

  it('keeps bundles useful when graph context is sparse and surfaces the gap explicitly', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults, capture: { retainCount: 0, operationIds: [] }, graph: false })
    const seeded = await captureAndProject({ fixture: sparseProject, suffix: 'sparse', memoryType: 'episodic', testEnv, tmk })
    recallResults.splice(0, recallResults.length, { document_id: seeded.engineDocumentId, text: 'Quiet scope has one clear next step and one unresolved follow-up.', score: 0.9, metadata: { source: 'mcp_retain', domain: 'general' } })

    const bundle = await callTool<AgentContextBundle>(createToolRegistry(testEnv, tmk), 'prepare_context_for_agent', {
      agent: 'chief_of_staff', intent: 'project', target: 'Quiet scope', limit: 4,
    })

    expect(bundle.highlights.length).toBeGreaterThan(0)
    expect(bundle.gaps.some((gap) => gap.mode === 'graph' && gap.kind === 'missing')).toBe(true)
    expect(bundle.followUpQuestions[0]).toContain('relationship history')
    expect(bundle.sources.some((source) => source.mode === 'raw')).toBe(true)
    expectPublicBundleShape(bundle)
  })
})
