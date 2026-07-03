import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { AgentContextBundle } from '../src/types/chief-of-staff-context'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalEntityRecord, CanonicalEdgeRecord } from '../src/types/canonical-governance-records'
import type { CanonicalGovernanceStore } from '../src/services/canonical-governance-store'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }
type SeededCapture = { captureId: string; documentId: string; operationId: string }

// Deterministic bag-of-words pseudo-embedder: shared tokens => similar vectors.
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

// Create a fully isolated test env with its OWN InMemory stores (both Symbol-keyed).
// Symbol keys are NOT copied by object spread, so stores MUST be installed after spread.
// Returns testEnv + govStore for direct entity/edge seeding.
function makeTestEnv(graphFails?: boolean): { testEnv: typeof env; govStore: CanonicalGovernanceStore } {
  const testEnv = {
    ...env,
    WORKER_DOMAIN: 'haetsalos.test',
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((t) => pseudoVector(t)),
      }),
    },
    HINDSIGHT: { fetch: async () => { throw new Error('Hindsight must not be called') } },
    GRAPHITI: {
      fetch: async () => { throw new Error(graphFails ? 'graphiti container unavailable' : 'Graphiti must not be called') },
    },
  } as unknown as typeof env
  // Install InMemory stores on the spread copy — NOT the original env — so both
  // captures and queries use the same in-process store via this exact object reference.
  installCanonicalMemoryTestStore(testEnv)
  const govStore = installCanonicalGovernanceTestStore(testEnv)
  return { testEnv, govStore }
}

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(`INSERT OR IGNORE INTO tenants (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at) VALUES (?, ?, ?, 'us', 'sms', ?, ?)`).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  await env.KV_SESSION.put(`cron_kek:${tenantId}`, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), { expirationTtl: 60 * 60 * 24 })
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`).bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

async function encryptFixture(fixture: CanonicalPipelineCaptureInput, tenantId: string, suffix: string, tmk: CryptoKey): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createToolRegistry(testEnv: typeof env, tenantId: string, tmk: CryptoKey): ToolRegistry {
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

async function capture(
  testEnv: typeof env,
  tenantId: string,
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  tmk: CryptoKey,
  memoryType: 'episodic' | 'semantic' | 'world' = 'episodic',
): Promise<SeededCapture> {
  vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(fixture, tenantId, suffix, tmk)
  const result = await captureThroughCanonicalPipeline({ ...input, memoryType }, testEnv, tenantId)
  vi.restoreAllMocks()
  return { captureId: result.capture.captureId, documentId: result.capture.documentId, operationId: result.capture.operationId }
}

function makeEntity(tenantId: string, kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return { id: crypto.randomUUID(), tenant_id: tenantId, kind, name, normalized_name: name.toLowerCase(), aliases_json: null, authority: 0, first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now }
}

function makeEdge(tenantId: string, srcId: string, dstId: string, type: string, captureId: string | null): CanonicalEdgeRecord {
  const now = Date.now()
  return { id: crypto.randomUUID(), tenant_id: tenantId, src_entity_id: srcId, dst_entity_id: dstId, edge_type: type, weight: 1, confidence: 0.8, trust_state: 'evidence', capture_id: captureId, claim_id: null, valid_from: now, valid_to: null, created_at: now, updated_at: now }
}

function expectPublicBundleShape(bundle: AgentContextBundle): void {
  expect(Object.keys(bundle).sort()).toEqual(['agent', 'compiled', 'confidence', 'evidence', 'followUpQuestions', 'gaps', 'highlights', 'intent', 'openLoops', 'recentChanges', 'relationships', 'risks', 'scope', 'sources', 'summary', 'target', 'timeline'].sort())
  expect(JSON.stringify(bundle)).not.toContain('engineDocumentId')
  expect(JSON.stringify(bundle)).not.toContain('engineOperationId')
}

beforeEach(() => { vi.restoreAllMocks() })

describe('9.2 chief-of-staff context builder', () => {
  it('assembles a person bundle with relationship, provenance, and open-loop signals', async () => {
    const tenantId = `test-tenant-context-92-person-${crypto.randomUUID()}`
    await ensureTenantWithKek(tenantId)
    const tmk = await (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`context-${tenantId}`), { name: 'HKDF' }, false, ['deriveKey'])
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ctx-salt'), info: new TextEncoder().encode('ctx-info') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    })()
    const { testEnv, govStore } = makeTestEnv()

    // Body mentions the target name and recall-style keywords so it scores >0.3
    // against the semantic policy query "What do I know about User?".
    const personBody = 'User: The operations checklist still needs an owner before the next meeting. I know this is a follow-up item.'
    const seeded = await capture(testEnv, tenantId, {
      tenantId, sourceSystem: 'mcp_memory_write', sourceRef: 'checklist-person', scope: 'general',
      title: 'Checklist status — User', body: personBody,
    }, 'person', tmk, 'semantic')

    // Seed graph entity + edge for 'User' so graph mode returns a relationship.
    const userEntity = await govStore.upsertEntity(makeEntity(tenantId, 'person', 'User'))
    const checklistEntity = await govStore.upsertEntity(makeEntity(tenantId, 'project', 'Operations Checklist'))
    await govStore.upsertEdge(makeEdge(tenantId, userEntity.id, checklistEntity.id, 'owns', seeded.captureId))

    const bundle = await callTool<AgentContextBundle>(
      createToolRegistry(testEnv, tenantId, tmk),
      'prepare_context_for_agent',
      { agent: 'chief_of_staff', intent: 'person', target: 'User', limit: 4 },
    )

    expect(bundle.intent).toBe('person')
    expect(bundle.relationships[0]).toContain('User')
    // The seeded document is found by at least one retrieval mode (semantic or raw).
    expect(bundle.sources.some((source) => source.documentId === seeded.documentId)).toBe(true)
    expect(bundle.evidence.some((block) => block.mode === 'composed')).toBe(true)
    expect(bundle.compiled?.mode).toBe('runtime_fallback')
    expect(bundle.compiled?.fallbackUsed).toBe(true)
    expectPublicBundleShape(bundle)
  })

  it('assembles a project bundle with summary, risks, recent changes, and provenance', async () => {
    const tenantId = `test-tenant-context-92-project-${crypto.randomUUID()}`
    await ensureTenantWithKek(tenantId)
    const tmk = await (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`context-${tenantId}`), { name: 'HKDF' }, false, ['deriveKey'])
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ctx-salt'), info: new TextEncoder().encode('ctx-info') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    })()
    const { testEnv, govStore } = makeTestEnv()

    const projectNote: CanonicalPipelineCaptureInput = { tenantId, sourceSystem: 'mcp_retain', sourceRef: 'launch-note', scope: 'general', title: 'Launch plan', body: 'Launch plan now runs through three milestones. Risk: the operations checklist still needs an owner before launch.', capturedAt: 1760280000000 }
    const projectGraphNote: CanonicalPipelineCaptureInput = { tenantId, sourceSystem: 'mcp_retain', sourceRef: 'launch-graph', scope: 'general', title: 'Launch plan', body: 'Launch Plan depends on Operations Checklist.', capturedAt: 1760323200000 }
    const projectConversation: CanonicalPipelineCaptureInput = { tenantId, sourceSystem: 'mcp_memory_write', sourceRef: 'launch-conversation', scope: 'general', title: 'Launch plan', body: 'User: We removed the optional work from the critical path.\nAssistant: Captured. Recent change: only the three launch milestones remain, and the checklist owner is still unresolved.', capturedAt: 1760366400000 }

    await capture(testEnv, tenantId, projectNote, 'note', tmk, 'episodic')
    await capture(testEnv, tenantId, projectGraphNote, 'graph', tmk, 'episodic')
    const seeded = await capture(testEnv, tenantId, projectConversation, 'conversation', tmk, 'semantic')

    const launchEntity = await govStore.upsertEntity(makeEntity(tenantId, 'project', 'Launch plan'))
    const checklistEntity = await govStore.upsertEntity(makeEntity(tenantId, 'project', 'Operations Checklist'))
    await govStore.upsertEdge(makeEdge(tenantId, launchEntity.id, checklistEntity.id, 'depends_on', seeded.captureId))

    const bundle = await callTool<AgentContextBundle>(
      createToolRegistry(testEnv, tenantId, tmk),
      'prepare_context_for_agent',
      { agent: 'chief_of_staff', intent: 'project', target: 'Launch plan', limit: 4 },
    )

    expect(bundle.intent).toBe('project')
    expect(bundle.summary).toContain('Launch plan')
    expect(bundle.recentChanges.some((item) => item.includes('milestones'))).toBe(true)
    expect(bundle.risks.some((item) => item.includes('owner') || item.includes('checklist'))).toBe(true)
    expect(bundle.timeline.length).toBeGreaterThan(0)
    expect(bundle.evidence.some((block) => block.mode === 'graph' && block.items.length > 0)).toBe(true)
    expect(bundle.sources.some((source) => source.projectionRef || source.graphRef)).toBe(true)
    expect(bundle.compiled?.mode).toBe('runtime_fallback')
    expect(bundle.compiled?.fallbackUsed).toBe(true)
    expectPublicBundleShape(bundle)
  })

  it('keeps bundles useful when graph context is sparse and surfaces the gap explicitly', async () => {
    const tenantId = `test-tenant-context-92-sparse-${crypto.randomUUID()}`
    await ensureTenantWithKek(tenantId)
    const tmk = await (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`context-${tenantId}`), { name: 'HKDF' }, false, ['deriveKey'])
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ctx-salt'), info: new TextEncoder().encode('ctx-info') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    })()
    // Graph fails → gap surfaced; no graph edges seeded for this tenant.
    const { testEnv } = makeTestEnv(true)
    const sparseProject: CanonicalPipelineCaptureInput = { tenantId, sourceSystem: 'mcp_retain', sourceRef: 'quiet-project', scope: 'general', title: 'Quiet scope', body: 'Quiet scope has one clear next step and one unresolved follow-up.', capturedAt: 1760452800000 }
    await capture(testEnv, tenantId, sparseProject, 'sparse', tmk, 'episodic')

    const bundle = await callTool<AgentContextBundle>(
      createToolRegistry(testEnv, tenantId, tmk),
      'prepare_context_for_agent',
      { agent: 'chief_of_staff', intent: 'project', target: 'Quiet scope', limit: 4 },
    )

    expect(bundle.highlights.length).toBeGreaterThan(0)
    // No canonical graph edges seeded → graph gap is surfaced in the bundle
    expect(bundle.gaps.some((gap) => gap.mode === 'graph' && gap.kind === 'missing')).toBe(true)
    // Raw mode finds the captured document; sources are grounded.
    expect(bundle.sources.some((source) => source.mode === 'raw')).toBe(true)
    // Composed mode gracefully degrades: either some items found or composed gap recorded.
    const composedEvidence = bundle.evidence.find((block: { mode: string }) => block.mode === 'composed')
    expect(composedEvidence).toBeDefined()
    expect(bundle.compiled?.mode).toBe('runtime_fallback')
    expect(bundle.compiled?.fallbackUsed).toBe(true)
    expectPublicBundleShape(bundle)
  })
})
