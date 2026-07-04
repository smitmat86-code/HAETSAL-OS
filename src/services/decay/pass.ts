// src/services/decay/pass.ts
// Phase 12 adaptive decay: importance × access-count reinforcement over
// METADATA ONLY. Inputs: canonical capture metadata (ids, timestamps, source
// system — via the list read model) and D1 broker-trace hit counts (how often
// a capture surfaced as the primary retrieval). This module takes NO key
// material — it cannot decrypt content even by accident (Law 2 by
// construction). Outcomes land in the content-free D1 memory_decay table:
// soft states only ('archived' is a ranking signal, not a delete).

import type { Env } from '../../types/env'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import { writeAuditLog } from '../../middleware/audit'

export interface DecaySummary {
  scored: number
  archived: number
  reinforced: number
  active: number
}

const HALF_LIFE_DAYS = 30
const ARCHIVE_THRESHOLD = 0.15
const REINFORCE_THRESHOLD = 0.9
const MIN_ARCHIVE_AGE_DAYS = 21
// KNOWN WINDOW (verifier, Phase 12): only the most recent 200 documents are
// (re)scored each pass; older items keep their last score and are never
// re-evaluated. Fine at single-tenant early scale; Phase 13 follow-up pages
// by scoring staleness instead of recency.
const CANDIDATE_LIMIT = 200

const USER_SOURCES = ['telegram', 'sendblue', 'sms', 'obsidian', 'file', 'mcp_retain', 'mcp:memory_write']

const DECAY_DDL = `CREATE TABLE IF NOT EXISTS memory_decay (
  tenant_id TEXT NOT NULL, capture_id TEXT NOT NULL,
  score REAL NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active', last_scored_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, capture_id))`

export async function ensureDecayTable(env: Env): Promise<void> {
  await env.D1_US.prepare(DECAY_DDL).run()
}

export function scoreCapture(input: {
  ageDays: number
  accessCount: number
  sourceSystem: string
}): number {
  const recency = Math.pow(0.5, input.ageDays / HALF_LIFE_DAYS)
  const reinforcement = 0.3 * Math.log2(1 + input.accessCount)
  const sourceBoost = USER_SOURCES.some(s => input.sourceSystem.startsWith(s)) ? 0.2 : 0
  return recency + reinforcement + sourceBoost
}

export async function runDecayPass(
  env: Env,
  tenantId: string,
  nowMs = Date.now(),
): Promise<DecaySummary> {
  await ensureDecayTable(env)
  const store = getCanonicalMemoryStore(env)
  const candidates = await store.listRecentDocuments(tenantId, null, CANDIDATE_LIMIT)

  const hits = await env.D1_US.prepare(
    `SELECT primary_capture_id AS captureId, COUNT(*) AS n FROM canonical_broker_traces
     WHERE tenant_id = ? AND primary_capture_id IS NOT NULL GROUP BY primary_capture_id`,
  ).bind(tenantId).all<{ captureId: string; n: number }>().catch(() => ({ results: [] as Array<{ captureId: string; n: number }> }))
  const accessByCapture = new Map((hits.results ?? []).map(row => [row.captureId, row.n]))

  const summary: DecaySummary = { scored: 0, archived: 0, reinforced: 0, active: 0 }
  const statements: D1PreparedStatement[] = []
  for (const candidate of candidates) {
    const ageDays = Math.max(0, (nowMs - candidate.captured_at) / 86_400_000)
    const accessCount = accessByCapture.get(candidate.capture_id) ?? 0
    const score = scoreCapture({ ageDays, accessCount, sourceSystem: candidate.source_system })
    const state = score >= REINFORCE_THRESHOLD || accessCount >= 2
      ? 'reinforced'
      : score < ARCHIVE_THRESHOLD && ageDays > MIN_ARCHIVE_AGE_DAYS
        ? 'archived'
        : 'active'
    summary.scored++
    summary[state]++
    statements.push(env.D1_US.prepare(
      `INSERT INTO memory_decay (tenant_id, capture_id, score, access_count, state, last_scored_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, capture_id) DO UPDATE SET
         score = excluded.score, access_count = excluded.access_count,
         state = excluded.state, last_scored_at = excluded.last_scored_at`,
    ).bind(tenantId, candidate.capture_id, score, accessCount, state, nowMs))
  }
  // Batch in chunks (D1 batch cap).
  for (let i = 0; i < statements.length; i += 50) {
    await env.D1_US.batch(statements.slice(i, i + 50))
  }
  void writeAuditLog(env, 'decay.pass_completed', tenantId, { agentIdentity: 'consolidation_cron' })
  return summary
}

export async function decaySummary(env: Env, tenantId: string): Promise<DecaySummary & { lastScoredAt: number | null }> {
  await ensureDecayTable(env)
  const rows = await env.D1_US.prepare(
    `SELECT state, COUNT(*) AS n, MAX(last_scored_at) AS latest FROM memory_decay
     WHERE tenant_id = ? GROUP BY state`,
  ).bind(tenantId).all<{ state: string; n: number; latest: number }>()
  const summary: DecaySummary & { lastScoredAt: number | null } = { scored: 0, archived: 0, reinforced: 0, active: 0, lastScoredAt: null }
  for (const row of rows.results ?? []) {
    summary.scored += row.n
    if (row.state === 'archived') summary.archived = row.n
    else if (row.state === 'reinforced') summary.reinforced = row.n
    else summary.active += row.n
    summary.lastScoredAt = Math.max(summary.lastScoredAt ?? 0, row.latest)
  }
  return summary
}
