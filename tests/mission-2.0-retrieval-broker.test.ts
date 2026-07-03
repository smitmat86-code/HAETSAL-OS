// Mission Phase 2: retrieval broker eval fixtures — named-thing retrieval,
// relationship queries, contradiction/trust ranking, hard negatives, intent
// routing, citations, and recall traces. All seven modes run through the one
// stable search_memory surface with no Hindsight/Graphiti involvement.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { decideCanonicalMemoryRoute } from '../src/services/canonical-memory-router'
import { searchCanonicalMemory } from '../src/services/canonical-memory-query'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { traceCanonicalRelationship, getCanonicalEntityTimeline } from '../src/services/canonical-graph-query'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { applyRetrievalBoosts } from '../src/services/retrieval-support'
import type { CanonicalEdgeRecord, CanonicalEntityRecord } from '../src/types/canonical-governance-records'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-mission-20-${SUITE_ID}`

installCanonicalMemoryTestStore(env)
const governanceStore = installCanonicalGovernanceTestStore(env)

// Deterministic bag-of-words pseudo-embedder: shared tokens => similar vectors.
function pseudoVector(text: string): number[] {
  const vector = new Array<number>(32).fill(0)
  for (const token of text.toLowerCase().split(/\W+/).filter((t) => t.length > 2)) {
    let hash = 0
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0
    vector[hash % 32] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / norm)
}

function makeTestEnv() {
  const testEnv = {
    ...env,
    WORKER_DOMAIN: 'haetsalos.test',
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((text) => pseudoVector(text)),
      }),
    },
    HINDSIGHT: {
      fetch: async () => { throw new Error('Hindsight must never be called by the retrieval broker') },
    },
    GRAPHITI: {
      fetch: async () => { throw new Error('Graphiti must never be called by the retrieval broker') },
    },
  } as unknown as typeof env
  vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  return testEnv
}

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`mission-20-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m20-salt'), info: new TextEncoder().encode('m20-info') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

async function capture(testEnv: typeof env, body: string, args?: { title?: string; scope?: string; capturedAt?: number }) {
  const tmk = await deriveTestTmk()
  return captureThroughCanonicalPipeline({
    tenantId: TENANT_ID,
    sourceSystem: 'notes',
    sourceRef: `m20-${crypto.randomUUID()}`,
    scope: args?.scope ?? 'projects',
    title: args?.title ?? null,
    body,
    bodyEncrypted: await encryptContentForArchive(body, tmk),
    capturedAt: args?.capturedAt ?? Date.now(),
    memoryType: 'episodic',
  }, testEnv, TENANT_ID)
}

function makeEntity(kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), tenant_id: TENANT_ID, kind, name,
    normalized_name: name.toLowerCase(), aliases_json: null, authority: 0,
    first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now,
  }
}

function makeEdge(src: string, dst: string, type: string, captureId: string | null): CanonicalEdgeRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), tenant_id: TENANT_ID, src_entity_id: src, dst_entity_id: dst,
    edge_type: type, weight: 1, confidence: 0.8, trust_state: 'evidence',
    capture_id: captureId, claim_id: null, valid_from: now, valid_to: null,
    created_at: now, updated_at: now,
  }
}

let sharedEnv: typeof env
let atlasCaptureId: string

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()

  sharedEnv = makeTestEnv()
  const atlas = await capture(sharedEnv, 'Alice Chen leads the Project Atlas kickoff and owns the launch checklist for Atlas.', { title: 'Atlas kickoff' })
  atlasCaptureId = atlas.capture.captureId
  await capture(sharedEnv, 'Grocery run: bananas, oat milk, coffee beans, paper towels.', { title: 'Groceries', scope: 'general' })
  await capture(sharedEnv, 'Old architecture retrospective from two months ago.', {
    title: 'Old retro', capturedAt: now - 60 * 24 * 60 * 60 * 1000,
  })

  const alice = await governanceStore.upsertEntity(makeEntity('person', 'Alice Chen'))
  const atlasEntity = await governanceStore.upsertEntity(makeEntity('project', 'Project Atlas'))
  const beacon = await governanceStore.upsertEntity(makeEntity('project', 'Project Beacon'))
  await governanceStore.upsertEdge(makeEdge(alice.id, atlasEntity.id, 'works_on', atlasCaptureId))
  await governanceStore.upsertEdge(makeEdge(atlasEntity.id, beacon.id, 'depends_on', null))
})

describe('mission 2.0 — deterministic intent routing with caller override', () => {
  it('routes phrasing to the right modes and honors explicit override', () => {
    expect(decideCanonicalMemoryRoute('brief me on Project Atlas').mode).toBe('composed')
    expect(decideCanonicalMemoryRoute('what is my relationship with Alice').mode).toBe('graph')
    expect(decideCanonicalMemoryRoute('what happened last week').mode).toBe('temporal')
    expect(decideCanonicalMemoryRoute('show the dossier for Atlas').mode).toBe('compiled')
    expect(decideCanonicalMemoryRoute('notes containing "launch checklist"').mode).toBe('lexical')
    expect(decideCanonicalMemoryRoute('who leads Atlas').mode).toBe('semantic')
    const overridden = decideCanonicalMemoryRoute('who leads Atlas', 'lexical')
    expect(overridden.mode).toBe('lexical')
    expect(overridden.explicit).toBe(true)
  })
})

describe('mission 2.0 — seven modes through one stable surface', () => {
  it('semantic: named-thing retrieval finds Atlas and rejects the hard negative', async () => {
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'who leads the Atlas kickoff', mode: 'semantic' }, sharedEnv, TENANT_ID,
    )
    expect(result.mode).toBe('semantic')
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0]?.captureId).toBe(atlasCaptureId)
    expect(result.items[0]?.citation?.trustState).toBe('evidence')
    expect(result.items[0]?.citation?.captureId).toBe(atlasCaptureId)
    expect(result.items.some((item) => item.preview.toLowerCase().includes('banana'))).toBe(false)
  })

  it('lexical: exact keyword match with citation', async () => {
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'bananas oat milk', mode: 'lexical' }, sharedEnv, TENANT_ID,
    )
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0]?.preview.toLowerCase()).toContain('banana')
    expect(result.items[0]?.citation?.memoryClass).toBeTruthy()
  })

  it('temporal: window query excludes the two-month-old capture', async () => {
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'what happened in the last 7 days', mode: 'temporal' }, sharedEnv, TENANT_ID,
    )
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.every((item) => (item.capturedAt ?? 0) > Date.now() - 8 * 24 * 60 * 60 * 1000)).toBe(true)
  })

  it('graph: relationship query over canonical edges with canonical provenance', async () => {
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'Alice Chen', mode: 'graph' }, sharedEnv, TENANT_ID,
    )
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.map((item) => item.graphContext?.relation)).toContain('works_on')
    expect(result.items[0]?.provenance?.projectionKind).toBe('canonical')
  })

  it('compiled: returns ok with no compiled views yet (empty, not an error)', async () => {
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'Project Atlas', mode: 'compiled' }, sharedEnv, TENANT_ID,
    )
    expect(result.mode).toBe('compiled')
    expect(result.status).toBe('ok')
  })

  it('raw: exact-phrase document lookup still works', async () => {
    const tmk = await deriveTestTmk()
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'launch checklist', mode: 'raw' }, sharedEnv, TENANT_ID, { tmk },
    )
    expect(result.items.length).toBeGreaterThan(0)
  })

  it('composed: assembles a deduplicated multi-mode bundle with citations', async () => {
    const result = await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'Alice Chen Atlas kickoff', mode: 'composed' }, sharedEnv, TENANT_ID,
    )
    expect(result.mode).toBe('composed')
    expect(result.items.length).toBeGreaterThan(0)
    const keys = result.items.map((item) => item.documentId ?? item.captureId ?? item.preview)
    expect(new Set(keys).size).toBe(keys.length)
    expect(result.items.some((item) => item.citation || item.graphContext)).toBe(true)
  })
})

describe('mission 2.0 — graph traversal (one-hop and two-hop)', () => {
  it('traces a direct relationship', async () => {
    const result = await traceCanonicalRelationship(
      { tenantId: TENANT_ID, from: 'Alice Chen', to: 'Project Atlas' }, sharedEnv, TENANT_ID,
    )
    expect(result.items[0]?.relation).toBe('works_on')
    expect(result.items[0]?.provenance.projectionKind).toBe('canonical')
    expect(result.items[0]?.provenance.captureId).toBe(atlasCaptureId)
  })

  it('two-hop expansion reaches Beacon through Atlas', async () => {
    const timeline = await getCanonicalEntityTimeline(
      { tenantId: TENANT_ID, entity: 'Alice Chen' }, sharedEnv, TENANT_ID,
    )
    const relations = timeline.items.map((item) => item.relation)
    expect(relations).toContain('works_on')
    expect(relations).toContain('depends_on')
  })
})

describe('mission 2.0 — trust-state and freshness boosts (contradiction ranking)', () => {
  it('ranks user_confirmed above disputed for otherwise-equal items', () => {
    const now = Date.now()
    const base = {
      captureId: 'c', documentId: 'd', title: 'Same title', scope: 'projects',
      sourceSystem: 'notes', sourceRef: null, preview: 'same', capturedAt: now, score: 0.8,
    }
    const ranked = applyRetrievalBoosts([
      { ...base, captureId: 'disputed', trustState: 'disputed' },
      { ...base, captureId: 'confirmed', trustState: 'user_confirmed' },
    ], { query: 'same', now })
    expect(ranked[0]?.captureId).toBe('confirmed')
    expect(ranked[1]?.captureId).toBe('disputed')
  })

  it('fresh items outrank stale ones at equal base score', () => {
    const now = Date.now()
    const base = {
      captureId: 'c', documentId: 'd', title: null, scope: 'projects',
      sourceSystem: 'notes', sourceRef: null, preview: 'same', score: 0.8, trustState: 'evidence',
    }
    const ranked = applyRetrievalBoosts([
      { ...base, captureId: 'old', capturedAt: now - 90 * 24 * 60 * 60 * 1000 },
      { ...base, captureId: 'new', capturedAt: now },
    ], { query: 'x', now })
    expect(ranked[0]?.captureId).toBe('new')
  })
})

describe('mission 2.0 — recall traces and engine isolation', () => {
  it('writes a canonical recall trace for a brokered query', async () => {
    await searchCanonicalMemory(
      { tenantId: TENANT_ID, query: 'trace me the Atlas kickoff', mode: 'semantic' }, sharedEnv, TENANT_ID,
    )
    // broker persists asynchronously without ctx — allow the microtask queue to drain
    await new Promise((resolve) => setTimeout(resolve, 50))
    const store = governanceStore as unknown as { recallTraces: Array<{ query_mode: string }> }
    expect(store.recallTraces.some((trace) => trace.query_mode === 'semantic')).toBe(true)
  })
})
