// src/services/ops-alert/ingest.ts
// Ops-alert normalization, dedupe, and orchestration (spec M4 / ADR-0006).
// Critical path for severity 'page' is deliberately shallow: one D1 dedupe
// roundtrip, then delivery. Memory write + brief surfacing happen async.

import type { Env } from '../../types/env'
import type {
  NormalizedOpsAlert, OpsAlertPayload, OpsAlertResult, OpsAlertSeverity, OpsAlertSource,
} from '../../types/ops-alert'
import { enqueueRetainArtifact } from '../ingestion/enqueue'
import { sha256Hex } from './registry'
import { deliverOpsPage } from './deliver'

const MAX_TITLE = 140
const MAX_BODY = 500

export async function normalizeOpsAlert(
  payload: OpsAlertPayload,
  source: OpsAlertSource,
): Promise<NormalizedOpsAlert> {
  const severity: OpsAlertSeverity =
    payload.severity === 'page' || payload.severity === 'notice'
      ? payload.severity
      : source.default_severity
  const text = payload.text?.trim() ?? ''
  const title = (payload.title?.trim() || text || 'ops alert').slice(0, MAX_TITLE)
  const body = (payload.body?.trim() || text).slice(0, MAX_BODY)
  const dedupeKey = payload.dedupe_key?.trim().slice(0, 128)
    || (await sha256Hex(`${title}\n${body}`)).slice(0, 40)
  return { severity, title, body, dedupeKey }
}

/** True when this firing should page: first sighting, or last page is older
 *  than the source's dedupe window (an ongoing outage re-pages per window). */
function pageIsDue(pagedAt: number | null, windowMs: number, now: number): boolean {
  return pagedAt === null || now - pagedAt > windowMs
}

export async function processOpsAlert(
  source: OpsAlertSource,
  payload: OpsAlertPayload,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<OpsAlertResult> {
  const alert = await normalizeOpsAlert(payload, source)
  const now = Date.now()

  // LESSON: INSERT OR IGNORE for at-least-once safety; meta.changes tells us
  // whether this (source, dedupe_key) is a first sighting or a replay.
  // Note: title only — alert bodies never land in D1 (1.1 plaintext guard);
  // the full text reaches T1 through the async episodic memory write.
  const insert = await env.D1_US.prepare(
    `INSERT OR IGNORE INTO ops_alerts
     (id, tenant_id, source_id, dedupe_key, severity, title,
      first_seen_at, last_seen_at, replay_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).bind(
    crypto.randomUUID(), source.tenant_id, source.id, alert.dedupeKey,
    alert.severity, alert.title, now, now,
  ).run()
  const isNew = (insert.meta?.changes ?? 0) > 0

  const row = await env.D1_US.prepare(
    `SELECT id, paged_at FROM ops_alerts WHERE source_id = ? AND dedupe_key = ?`,
  ).bind(source.id, alert.dedupeKey).first<{ id: string; paged_at: number | null }>()
  if (!row) throw new Error('ops_alerts readback failed')

  if (!isNew) {
    await env.D1_US.prepare(
      `UPDATE ops_alerts SET last_seen_at = ?, replay_count = replay_count + 1 WHERE id = ?`,
    ).bind(now, row.id).run()
  }

  const base = { alertId: row.id, source: source.id, severity: alert.severity }

  if (alert.severity !== 'page') {
    if (isNew) queueAlertMemory(source, alert, env, ctx)
    return { outcome: isNew ? 'noticed' : 'duplicate', ...base }
  }

  const windowMs = source.dedupe_window_s * 1000
  if (!pageIsDue(row.paged_at, windowMs, now)) {
    return { outcome: 'duplicate', ...base }
  }

  const message = alert.body && alert.body !== alert.title
    ? `🚨 [${source.id}] ${alert.title}\n${alert.body}`
    : `🚨 [${source.id}] ${alert.title}`
  const delivery = await deliverOpsPage(source.tenant_id, message, env)

  // Awaited (not waitUntil): paged_at is dedupe state — losing it double-pages.
  if (delivery.delivered) {
    await env.D1_US.prepare(
      `UPDATE ops_alerts SET paged_at = ?, page_channel = ? WHERE id = ?`,
    ).bind(now, delivery.channel, row.id).run()
  }
  if (isNew) queueAlertMemory(source, alert, env, ctx)
  return { outcome: delivery.delivered ? 'paged' : 'page_failed', ...base }
}

/** Async episodic memory with provenance (ADR-0006: alerts become memories). */
function queueAlertMemory(
  source: OpsAlertSource,
  alert: NormalizedOpsAlert,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): void {
  ctx.waitUntil(enqueueRetainArtifact({
    tenantId: source.tenant_id,
    source: 'ops_alert',
    content: `Ops alert (${alert.severity}) from ${source.id}: ${alert.title}`
      + (alert.body && alert.body !== alert.title ? ` — ${alert.body}` : ''),
    occurredAt: Date.now(),
    memoryType: 'episodic',
    domain: 'general',
    provenance: `ops_alert:${source.id}`,
    metadata: { ops_alert: true, severity: alert.severity, source_id: source.id },
  }, env).catch((error) => {
    console.error('OPS_ALERT_MEMORY_ENQUEUE_FAILED', {
      source: source.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }))
}
