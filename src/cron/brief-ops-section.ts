// src/cron/brief-ops-section.ts
// M4 standing ops section for the morning brief (ADR-0006 dead-man's switch):
// a positive freshness line that MUST always render — its absence, or an
// "unavailable" reading, is itself the signal — plus last-24h ops alerts.

import type { Env } from '../types/env'
import { createPostgresSql } from '../services/postgres-sql'

export const OPS_FRESHNESS_FALLBACK = '  health spine: freshness unavailable'

/**
 * Dead-man's freshness line for source #1 (haetsal-health). Reads the
 * haetsal_health Neon DB through a SELECT-only role (HEALTH_SPINE_RO_URL —
 * forerunner of Phase 4's haetsal_ro). Never throws; degraded states are
 * reported truthfully instead of omitted.
 */
export async function fetchOpsFreshnessLine(env: Env): Promise<string> {
  const url = env.HEALTH_SPINE_RO_URL?.trim()
  if (!url) return `${OPS_FRESHNESS_FALLBACK} (read-only access not configured)`
  try {
    const sql = createPostgresSql(url)
    const rows = await sql`SELECT max(received_at) AS last_received_at FROM raw_ingest` as
      Array<{ last_received_at: string | Date | null }>
    const last = rows[0]?.last_received_at
    if (!last) return '  health spine: no ingests on record'
    const hours = (Date.now() - new Date(last).getTime()) / 3_600_000
    return `  health spine: last ingest ${hours.toFixed(1)}h ago`
  } catch (error) {
    console.warn('OPS_FRESHNESS_READ_FAILED', {
      error: error instanceof Error ? error.message : String(error),
    })
    return `${OPS_FRESHNESS_FALLBACK} (read failed)`
  }
}

/** Last-24h ops alerts ('' when quiet); marks surfaced rows for bookkeeping. */
export async function fetchOpsAlertLines(tenantId: string, env: Env): Promise<string> {
  const since = Date.now() - 86_400_000
  const rows = await env.D1_US.prepare(
    `SELECT id, source_id, severity, title, paged_at, replay_count FROM ops_alerts
     WHERE tenant_id = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 6`,
  ).bind(tenantId, since).all<{
    id: string; source_id: string; severity: string; title: string
    paged_at: number | null; replay_count: number
  }>()
  if (!rows.results?.length) return ''
  const lines = rows.results.map((a) => {
    const marker = a.severity === 'page' ? (a.paged_at ? '🚨' : '⚠️ (page failed)') : '•'
    const replays = a.replay_count > 0 ? ` ×${a.replay_count + 1}` : ''
    return `  ${marker} [${a.source_id}] ${a.title}${replays}`
  })
  const surfacedAt = Date.now()
  await env.D1_US.batch(rows.results.map((a) => env.D1_US.prepare(
    `UPDATE ops_alerts SET brief_surfaced_at = ? WHERE id = ? AND brief_surfaced_at IS NULL`,
  ).bind(surfacedAt, a.id))).catch(() => {})
  return lines.join('\n')
}

/** Composed section: freshness line first (always), then any alerts. */
export async function fetchOpsSection(tenantId: string, env: Env): Promise<string> {
  const [freshness, alerts] = await Promise.all([
    fetchOpsFreshnessLine(env),
    fetchOpsAlertLines(tenantId, env).catch(() => ''),
  ])
  return alerts ? `${freshness}\n${alerts}` : freshness
}
