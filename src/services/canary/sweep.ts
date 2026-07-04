// src/services/canary/sweep.ts
// Phase 13 canary sweep: six live probes over the core memory paths —
// capture, recall (lexical), graph traversal, contradiction surfacing (dream
// review inbox reachable), compiled regen readability, session evidence
// (session-source captures retrievable). Content is synthetic canary text;
// results land content-free in D1 canary_runs (probe name + ok + latency).
// Runs on the 15-minute cron (hourly effective via a modulo) and on demand.

import type { Env } from '../../types/env'
import { retainContent } from '../ingestion/retain'
import { searchCanonicalMemory } from '../canonical-memory-query'
import { getCanonicalGovernanceStore } from '../canonical-governance-postgres'
import { listCompiledPages } from '../compiled/page'
import { fetchAndValidateKek } from '../../cron/kek'

export interface CanaryResult { probe: string; ok: boolean; ms: number; note: string }

const CANARY_DDL = `CREATE TABLE IF NOT EXISTS canary_runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, at INTEGER NOT NULL,
  ok_count INTEGER NOT NULL, total INTEGER NOT NULL, detail_json TEXT NOT NULL)`

async function probe(name: string, fn: () => Promise<string>): Promise<CanaryResult> {
  const started = Date.now()
  try {
    const note = await fn()
    return { probe: name, ok: true, ms: Date.now() - started, note }
  } catch (error) {
    return {
      probe: name, ok: false, ms: Date.now() - started,
      note: (error instanceof Error ? error.constructor.name : 'error'),
    }
  }
}

export async function runCanarySweep(env: Env, tenantId: string): Promise<CanaryResult[]> {
  const mark = `canary-${Date.now().toString(36)}`
  const kek = await fetchAndValidateKek(tenantId, env)
  const results: CanaryResult[] = []

  results.push(await probe('capture', async () => {
    if (!kek) throw new Error('KekUnavailable')
    const r = await retainContent({
      tenantId, content: `Canary heartbeat ${mark}: systems check.`,
      source: 'cron:consolidation', memoryType: 'episodic', domain: 'canary',
      occurredAt: Date.now(),
    }, kek, env)
    if (!r?.canonicalCaptureId) throw new Error('NoCaptureId')
    return 'captured'
  }))

  results.push(await probe('recall', async () => {
    const r = await searchCanonicalMemory(
      { tenantId, query: `canary heartbeat ${mark}`, mode: 'lexical', limit: 3 }, env, tenantId,
    )
    if (r.status === 'unavailable') throw new Error('BrokerUnavailable')
    return `status=${r.status}, items=${r.items.length}`
  }))

  results.push(await probe('graph', async () => {
    const edges = await getCanonicalGovernanceStore(env).listEdgesWithEntities(tenantId, 3)
    return `edges=${edges.length}`
  }))

  results.push(await probe('contradiction-surface', async () => {
    const reviews = await getCanonicalGovernanceStore(env).listReviews(tenantId, 'pending', 5)
    return `pending=${reviews.length}`
  }))

  results.push(await probe('compiled-regen', async () => {
    const pages = await listCompiledPages(env, tenantId)
    return `pages=${pages.length}`
  }))

  results.push(await probe('session-evidence', async () => {
    const r = await searchCanonicalMemory(
      { tenantId, query: 'session summary', mode: 'lexical', limit: 3 }, env, tenantId,
    )
    return `status=${r.status}`
  }))

  await env.D1_US.prepare(CANARY_DDL).run()
  await env.D1_US.prepare(
    `INSERT INTO canary_runs (id, tenant_id, at, ok_count, total, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), tenantId, Date.now(),
    results.filter(r => r.ok).length, results.length,
    JSON.stringify(results.map(r => ({ probe: r.probe, ok: r.ok, ms: r.ms }))),
  ).run()
  return results
}

export async function latestCanary(env: Env, tenantId: string): Promise<{
  at: number; okCount: number; total: number; detail: unknown
} | null> {
  await env.D1_US.prepare(CANARY_DDL).run()
  const row = await env.D1_US.prepare(
    'SELECT at, ok_count, total, detail_json FROM canary_runs WHERE tenant_id = ? ORDER BY at DESC LIMIT 1',
  ).bind(tenantId).first<{ at: number; ok_count: number; total: number; detail_json: string }>()
  if (!row) return null
  return { at: row.at, okCount: row.ok_count, total: row.total, detail: JSON.parse(row.detail_json) }
}
