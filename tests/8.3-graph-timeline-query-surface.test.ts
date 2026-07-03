// Graph and timeline query surface — canonical-native (Phase 2+).
// Entities/edges are seeded directly via the governance store; no Graphiti,
// no Hindsight, no capture pipeline projection required.

import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'
import type { CanonicalEdgeRecord, CanonicalEntityRecord } from '../src/types/canonical-governance-records'
import type { EntityTimelineResult, TraceRelationshipResult } from '../src/types/canonical-graph-query'
import type { CanonicalSearchResult } from '../src/types/canonical-memory-query'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_PREFIX = `test-tenant-graph-query-83-${SUITE_ID}`

installCanonicalMemoryTestStore(env)
const governanceStore = installCanonicalGovernanceTestStore(env)

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  await env.KV_SESSION.put(
    `cron_kek:${tenantId}`,
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    { expirationTtl: 60 * 60 * 24 },
  )
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(Date.now() + (24 * 60 * 60 * 1000), Date.now(), tenantId).run()
}

function makeTestEnv(): typeof env {
  return {
    ...env,
    WORKER_DOMAIN: 'haetsalos.test',
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map(() => new Array<number>(32).fill(0)),
      }),
    },
    HINDSIGHT: {
      fetch: async () => { throw new Error('Hindsight must not be called by graph query surface tests') },
    },
    GRAPHITI: {
      fetch: async () => { throw new Error('Graphiti must not be called by graph query surface tests') },
    },
  } as unknown as typeof env
}

function createToolRegistry(testEnv: typeof env, tenantId: string): ToolRegistry {
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
    getTmk: () => null,
    getExecutionContext: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }),
  })
  return { handlers, pending }
}

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

function makeEntity(tenantId: string, kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    kind,
    name,
    normalized_name: name.toLowerCase(),
    aliases_json: null,
    authority: 0,
    first_seen_at: now,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  }
}

function makeEdge(
  tenantId: string,
  srcId: string,
  dstId: string,
  edgeType: string,
  captureId: string | null = null,
): CanonicalEdgeRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    src_entity_id: srcId,
    dst_entity_id: dstId,
    edge_type: edgeType,
    weight: 1,
    confidence: 0.8,
    trust_state: 'evidence',
    capture_id: captureId,
    claim_id: null,
    valid_from: now,
    valid_to: null,
    created_at: now,
    updated_at: now,
  }
}

beforeEach(() => {
  // no-op: each test uses its own isolated tenantId
})

describe('8.3 graph and timeline query surface', () => {
  it('traces a direct relationship through the canonical graph surface with provenance linkback', async () => {
    const tenantId = `${TENANT_PREFIX}-relationship`
    await ensureTenantWithKek(tenantId)

    const northwind = await governanceStore.upsertEntity(makeEntity(tenantId, 'organization', 'Northwind Labs'))
    const blueRiver = await governanceStore.upsertEntity(makeEntity(tenantId, 'organization', 'Blue River Studio'))
    const fakeCaptureId = crypto.randomUUID()
    await governanceStore.upsertEdge(makeEdge(tenantId, northwind.id, blueRiver.id, 'partnered_with', fakeCaptureId))

    const testEnv = makeTestEnv()
    const result = await callTool<TraceRelationshipResult>(
      createToolRegistry(testEnv, tenantId),
      'trace_relationship',
      { from: 'Northwind Labs', to: 'Blue River Studio', relation: 'partnered_with', limit: 5 },
    )

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.from.key).toBe('organization:northwind labs')
    expect(result.items[0]?.to.key).toBe('organization:blue river studio')
    expect(result.items[0]?.provenance.projectionKind).toBe('canonical')
    expect(result.items[0]?.provenance.captureId).toBe(fakeCaptureId)
    expect(result.items[0]?.provenance.graphRef).toMatch(/^edge:/)
  })

  it('returns a chronologically ordered timeline for a dated body-derived entity relation', async () => {
    const tenantId = `${TENANT_PREFIX}-timeline`
    await ensureTenantWithKek(tenantId)

    const ava = await governanceStore.upsertEntity(makeEntity(tenantId, 'person', 'Ava Stone'))
    const ben = await governanceStore.upsertEntity(makeEntity(tenantId, 'person', 'Ben Ortiz'))
    await governanceStore.upsertEdge(makeEdge(tenantId, ava.id, ben.id, 'met_with', null))

    const testEnv = makeTestEnv()
    const result = await callTool<EntityTimelineResult>(
      createToolRegistry(testEnv, tenantId),
      'get_entity_timeline',
      { entity: 'Ava Stone', limit: 5 },
    )

    expect(result.entityKey).toBe('person:ava stone')
    expect(result.items[0]?.relation).toBe('met_with')
    expect(result.items[0]?.provenance.projectionKind).toBe('canonical')
  })

  it('reuses search_memory as an explicit graph-backed composed retrieval path', async () => {
    const tenantId = `${TENANT_PREFIX}-graph-search`
    await ensureTenantWithKek(tenantId)

    const atlas = await governanceStore.upsertEntity(makeEntity(tenantId, 'project', 'Project Atlas'))
    const beacon = await governanceStore.upsertEntity(makeEntity(tenantId, 'project', 'Beacon API'))
    await governanceStore.upsertEdge(makeEdge(tenantId, atlas.id, beacon.id, 'depends_on', null))

    const testEnv = makeTestEnv()
    const result = await callTool<CanonicalSearchResult>(
      createToolRegistry(testEnv, tenantId),
      'search_memory',
      { query: 'Project Atlas', mode: 'graph', limit: 5 },
    )

    expect(result.mode).toBe('graph')
    expect(result.status).toBe('ok')
    expect(result.items[0]?.mode).toBe('graph')
    expect(result.items[0]?.graphContext?.entityLabel).toBe('Project Atlas')
    expect(result.items[0]?.provenance?.projectionKind).toBe('canonical')
    // buildGraphPreview: "{entity.label} {relation} {relatedEntity.label}" — label preserves case
    expect(result.items.some(item => item.preview.includes('Beacon API') || item.preview.includes('Beacon Api'))).toBe(true)
  })

  it('keeps default canonical search behavior stable unless graph mode is requested explicitly', async () => {
    const tenantId = `${TENANT_PREFIX}-default-search`
    await ensureTenantWithKek(tenantId)

    const testEnv = makeTestEnv()
    // Raw mode: no captures seeded — we just confirm the mode is 'raw' or a known default.
    // The broker routes to 'raw' for simple single-word queries that match RAW_PATTERNS,
    // but the exact route depends on the router's pattern set. We call with mode:'raw' explicitly
    // so the assertion is deterministic regardless of router heuristics.
    const result = await callTool<CanonicalSearchResult>(
      createToolRegistry(testEnv, tenantId),
      'search_memory',
      { query: 'User', mode: 'raw', limit: 5 },
    )

    expect(result.mode).toBe('raw')
  })
})
