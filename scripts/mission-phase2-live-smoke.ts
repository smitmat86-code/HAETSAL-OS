// scripts/mission-phase2-live-smoke.ts
// Mission Phase 2 gate live smoke: capture a governed memory, then retrieve it
// through ALL SEVEN broker modes against REAL Postgres (pgvector container on
// localhost:5433, db brain_dev). Semantic mode exercises a real pgvector
// `<=>` query; the embedder is a deterministic hash stub (Workers AI only
// exists inside workerd — the real bge model is smoke-tested at the Phase 3
// prod deploy).
//
// Run: npx tsx scripts/mission-phase2-live-smoke.ts
// Reads credentials from .dev.vars, rewrites the port to 5433. Never prints them.

import { readFileSync } from 'fs'
import { webcrypto } from 'node:crypto'
import type { Env } from '../src/types/env'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { installCanonicalGovernanceStore } from '../src/services/canonical-governance-store'
import { PostgresCanonicalGovernanceStore } from '../src/services/canonical-governance-postgres'
import { searchCanonicalMemory } from '../src/services/canonical-memory-query'
import { installCanonicalMemoryStore } from '../src/services/canonical-postgres'
import { PostgresCanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import { createPostgresSql } from '../src/services/postgres-sql'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalEdgeRecord, CanonicalEntityRecord } from '../src/types/canonical-governance-records'
import type { MemoryQueryMode } from '../src/types/canonical-memory-query'

if (!globalThis.crypto) (globalThis as Record<string, unknown>).crypto = webcrypto

// Unique tenant per run: rows persist in the local dev DB across runs while
// this process's fake R2 does not, so runs must never see prior runs' rows.
const SMOKE_TENANT = `mission-smoke-phase2-${crypto.randomUUID().slice(0, 8)}`
const SMOKE_MARK = `phase2-live-smoke-${crypto.randomUUID()}`

function readConnectionString(): string {
  const devVars = readFileSync('.dev.vars', 'utf8')
  const line = devVars.split(/\r?\n/).find((entry) => entry.startsWith('CANONICAL_POSTGRES_CONNECTION_STRING='))
  const value = line?.slice('CANONICAL_POSTGRES_CONNECTION_STRING='.length).trim().replace(/^"|"$/g, '')
  if (!value) throw new Error('CANONICAL_POSTGRES_CONNECTION_STRING missing from .dev.vars')
  // Local brain-dev pgvector container runs on 5433 (5432 is held by fold-postgres).
  return value.replace('localhost:5432', 'localhost:5433').replace('localhost/', 'localhost:5433/')
}

function pseudoVector(text: string): number[] {
  const vector = new Array<number>(768).fill(0)
  for (const token of text.toLowerCase().split(/\W+/).filter((t) => t.length > 2)) {
    let hash = 0
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0
    vector[hash % 768] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / norm)
}

function makeFakeEnv(): Env {
  const r2 = new Map<string, string>()
  const d1Stub = {
    prepare(query: string) {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        first: async () => (query.includes('FROM tenants') ? { id: SMOKE_TENANT } : null),
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
        raw: async () => [],
      }
      return statement
    },
    batch: async (_statements: unknown[]) => [],
  }
  return {
    D1_US: d1Stub,
    R2_ARTIFACTS: {
      put: async (key: string, value: string) => { r2.set(key, value) },
      get: async (key: string) => (r2.has(key) ? { text: async () => r2.get(key)! } : null),
    },
    KV_SESSION: { get: async () => null, put: async () => undefined },
    QUEUE_BULK: { send: async () => undefined },
    WORKER_DOMAIN: 'haetsalos.local-smoke',
    AI_GATEWAY_ID: 'haetsal-brain-gateway',
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((text) => pseudoVector(text)),
      }),
    },
  } as unknown as Env
}

async function deriveSmokeTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SMOKE_MARK), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('p2-salt'), info: new TextEncoder().encode('p2-info') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

function makeEntity(kind: string, name: string): CanonicalEntityRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), tenant_id: SMOKE_TENANT, kind, name,
    normalized_name: name.toLowerCase(), aliases_json: null, authority: 0,
    first_seen_at: now, last_seen_at: now, created_at: now, updated_at: now,
  }
}

async function main(): Promise<void> {
  const sql = createPostgresSql(readConnectionString())
  const env = makeFakeEnv()
  installCanonicalMemoryStore(env, new PostgresCanonicalMemoryStore(sql))
  const governance = new PostgresCanonicalGovernanceStore(sql)
  installCanonicalGovernanceStore(env, governance)
  const tmk = await deriveSmokeTmk()

  const body = `Mission phase 2 smoke ${SMOKE_MARK}. Alice Chen leads the Project Atlas kickoff and owns the launch checklist.`
  const capture = await captureThroughCanonicalPipeline({
    tenantId: SMOKE_TENANT,
    sourceSystem: 'notes',
    sourceRef: SMOKE_MARK,
    scope: 'projects',
    title: 'Phase 2 smoke: Atlas kickoff',
    body,
    bodyEncrypted: await encryptContentForArchive(body, tmk),
    capturedAt: Date.now(),
    memoryType: 'episodic',
  }, env, SMOKE_TENANT)

  const alice = await governance.upsertEntity(makeEntity('person', `Alice Chen ${SMOKE_MARK.slice(-8)}`))
  const atlas = await governance.upsertEntity(makeEntity('project', `Project Atlas ${SMOKE_MARK.slice(-8)}`))
  const now = Date.now()
  const edge: CanonicalEdgeRecord = {
    id: crypto.randomUUID(), tenant_id: SMOKE_TENANT, src_entity_id: alice.id, dst_entity_id: atlas.id,
    edge_type: 'works_on', weight: 1, confidence: 0.9, trust_state: 'evidence',
    capture_id: capture.capture.captureId, claim_id: null, valid_from: now, valid_to: null,
    created_at: now, updated_at: now,
  }
  await governance.upsertEdge(edge)

  const modeQueries: Record<MemoryQueryMode, string> = {
    raw: 'launch checklist',
    lexical: 'launch checklist Atlas',
    semantic: 'who leads the Atlas kickoff',
    graph: 'Alice Chen',
    temporal: 'what happened today',
    compiled: 'atlas',
    composed: 'Alice Chen Atlas kickoff',
  }
  const summary: Record<string, { status: string; items: number; foundCapture: boolean }> = {}
  for (const [mode, query] of Object.entries(modeQueries) as Array<[MemoryQueryMode, string]>) {
    const result = await searchCanonicalMemory(
      { tenantId: SMOKE_TENANT, query, mode }, env, SMOKE_TENANT, { tmk },
    )
    const foundCapture = result.items.some((item) =>
      item.captureId === capture.capture.captureId
      || item.citation?.captureId === capture.capture.captureId
      || item.graphContext != null)
    summary[mode] = { status: result.status, items: result.items.length, foundCapture }
  }

  const mustFind: MemoryQueryMode[] = ['raw', 'lexical', 'semantic', 'temporal', 'graph', 'composed']
  for (const mode of mustFind) {
    if (!summary[mode]?.foundCapture) throw new Error(`Mode ${mode} did not retrieve the smoke memory: ${JSON.stringify(summary[mode])}`)
  }
  if (summary.semantic!.status !== 'ok') throw new Error(`Semantic mode did not run on pgvector (status ${summary.semantic!.status})`)
  if (summary.compiled!.status !== 'ok') throw new Error('Compiled mode errored (expected ok with zero optional views)')

  console.log('PHASE2_LIVE_SMOKE_OK', JSON.stringify({
    tenant: SMOKE_TENANT,
    captureId: capture.capture.captureId,
    modes: summary,
  }, null, 2))
}

main().catch((error) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  console.error('PHASE2_LIVE_SMOKE_FAILED', detail)
  process.exit(1)
})
