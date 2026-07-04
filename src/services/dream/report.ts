// src/services/dream/report.ts
// Dream report assembly + persistence. The report body (content) is captured
// through the governed retain path into canonical Postgres; D1 gets only the
// content-free run row (counts, ids, status) for dedup and the dashboard.
// Includes a lazy-DDL fallback (Phase 5 precedent: this environment's CF
// token cannot run D1 migrations).

import type { Env } from '../../types/env'
import { retainContent } from '../ingestion/retain'
import { allFindings } from './proposals'
import { DREAM_REPORT_SCOPE, type DreamCounts, type DreamFindings, type DreamRunRow } from './types'

export function composeDreamReport(runDate: string, findings: DreamFindings, counts: DreamCounts): string {
  const lines: string[] = [`Dream cycle report — ${runDate}`, '']
  if (findings.facts.length) {
    lines.push('New facts learned:', ...findings.facts.map(f => `- ${f}`), '')
  }
  const groups: Array<[string, typeof findings.contradictions]> = [
    ['Contradictions surfaced', findings.contradictions],
    ['Likely superseded', findings.supersessions],
    ['Promotion candidates (awaiting review)', findings.promotions],
    ['Relationship links proposed', findings.entityLinks],
    ['Gaps identified', findings.gaps],
  ]
  for (const [title, items] of groups) {
    if (!items.length) continue
    lines.push(`${title}:`, ...items.map(i => `- ${i.statement}${i.rationale ? ` (${i.rationale})` : ''}`), '')
  }
  if (lines.length === 2) lines.push('Quiet night — no new signals above the confidence floor.')
  lines.push('', `Window: ${counts.eventsSeen} recent memories reviewed; ${counts.proposalsWritten} proposals filed to the review inbox. Nothing was auto-promoted.`)
  return lines.join('\n')
}

export async function persistDreamReport(
  env: Env,
  tenantId: string,
  reportBody: string,
  runDate: string,
  kek: CryptoKey,
): Promise<{ captureId: string | null; documentId: string | null }> {
  // The Cron KEK is the tenant TMK raw bytes (kek.ts) — the retain path's
  // archival sidecar encrypts with it, so Matt's session can decrypt later.
  const result = await retainContent({
    tenantId,
    content: reportBody,
    source: 'cron:dream',
    sourceRef: `dream/${runDate}`,
    memoryType: 'episodic',
    domain: DREAM_REPORT_SCOPE,
    provenance: 'dream_cycle_report',
    occurredAt: Date.now(),
  }, kek, env)
  return {
    captureId: result?.canonicalCaptureId ?? null,
    documentId: result?.canonicalDocumentId ?? null,
  }
}

const DREAM_RUNS_DDL = `CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_date TEXT NOT NULL,
  started_at INTEGER NOT NULL, completed_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
  trigger TEXT NOT NULL DEFAULT 'cron', events_seen INTEGER NOT NULL DEFAULT 0,
  proposals_written INTEGER NOT NULL DEFAULT 0, contradictions INTEGER NOT NULL DEFAULT 0,
  supersessions INTEGER NOT NULL DEFAULT 0, promotions INTEGER NOT NULL DEFAULT 0,
  gaps INTEGER NOT NULL DEFAULT 0, report_capture_id TEXT, report_document_id TEXT, error_message TEXT)`

export async function ensureDreamRunsTable(env: Env): Promise<void> {
  await env.D1_US.prepare(DREAM_RUNS_DDL).run()
  await env.D1_US.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_runs_tenant_date ON dream_runs(tenant_id, run_date)',
  ).run()
}

/** INSERT OR IGNORE dedup: one run per tenant per date. Returns run id or null. */
export async function claimDreamRun(env: Env, tenantId: string, runDate: string, trigger: string): Promise<string | null> {
  await ensureDreamRunsTable(env)
  const id = crypto.randomUUID()
  const result = await env.D1_US.prepare(
    `INSERT OR IGNORE INTO dream_runs (id, tenant_id, run_date, started_at, status, trigger)
     VALUES (?, ?, ?, ?, 'running', ?)`,
  ).bind(id, tenantId, runDate, Date.now(), trigger).run()
  return result.meta.changes ? id : null
}

export async function finishDreamRun(
  env: Env, runId: string,
  outcome: { status: 'completed' | 'failed'; counts?: DreamCounts; captureId?: string | null; documentId?: string | null; error?: string },
): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE dream_runs SET status = ?, completed_at = ?, events_seen = ?, proposals_written = ?,
       contradictions = ?, supersessions = ?, promotions = ?, gaps = ?,
       report_capture_id = ?, report_document_id = ?, error_message = ?
     WHERE id = ?`,
  ).bind(
    outcome.status, Date.now(),
    outcome.counts?.eventsSeen ?? 0, outcome.counts?.proposalsWritten ?? 0,
    outcome.counts?.contradictions ?? 0, outcome.counts?.supersessions ?? 0,
    outcome.counts?.promotions ?? 0, outcome.counts?.gaps ?? 0,
    outcome.captureId ?? null, outcome.documentId ?? null,
    outcome.error?.slice(0, 300) ?? null, runId,
  ).run()
}

export async function latestDreamRun(
  env: Env, tenantId: string, options?: { completedOnly?: boolean },
): Promise<DreamRunRow | null> {
  await ensureDreamRunsTable(env)
  const completedOnly = options?.completedOnly ?? true
  const row = completedOnly
    ? await env.D1_US.prepare(
      `SELECT * FROM dream_runs WHERE tenant_id = ? AND status = 'completed'
       ORDER BY started_at DESC LIMIT 1`).bind(tenantId).first<DreamRunRow>()
    : await env.D1_US.prepare(
      `SELECT * FROM dream_runs WHERE tenant_id = ? AND status != 'running'
       ORDER BY started_at DESC LIMIT 1`).bind(tenantId).first<DreamRunRow>()
  return row ?? null
}
