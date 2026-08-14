// src/services/ops-alert/ingest.ts
// Ops-alert normalization, dedupe, and orchestration (spec M4 / ADR-0006).
// Critical path for severity 'page': one atomic D1 upsert, one atomic claim,
// then delivery. Memory write + brief surfacing happen async.

import type { Env } from '../../types/env'
import type {
  NormalizedOpsAlert, OpsAlertPayload, OpsAlertResult, OpsAlertSeverity, OpsAlertSource,
} from '../../types/ops-alert'
import { sha256Hex } from './registry'
import { deliverOpsPage } from './deliver'
import { queueAlertMemory } from './memory'

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
  // Derived keys normalize numbers away ("stale 3.4h ago" / "3.5h ago" are the
  // SAME condition) — otherwise any embedded measurement defeats the window
  // and a repeating sender pages every firing (live-fire finding, review M4).
  const dedupeKey = payload.dedupe_key?.trim().slice(0, 128)
    || (await sha256Hex(`${title}\n${body}`.replace(/\d+(?:\.\d+)?/g, '#'))).slice(0, 40)
  return { severity, title, body, dedupeKey }
}

export async function processOpsAlert(
  source: OpsAlertSource,
  payload: OpsAlertPayload,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<OpsAlertResult> {
  const alert = await normalizeOpsAlert(payload, source)
  const now = Date.now()

  // One atomic upsert: first sighting inserts, replays refresh last_seen_at
  // AND severity/title (an escalated replay must not render its stale
  // first-sighting text in the brief) and bump replay_count.
  const row = await env.D1_US.prepare(
    `INSERT INTO ops_alerts
     (id, tenant_id, source_id, dedupe_key, severity, title,
      first_seen_at, last_seen_at, replay_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(source_id, dedupe_key) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       severity = excluded.severity,
       title = excluded.title,
       replay_count = replay_count + 1
     RETURNING id, paged_at, replay_count`,
  ).bind(
    crypto.randomUUID(), source.tenant_id, source.id, alert.dedupeKey,
    alert.severity, alert.title, now, now,
  ).first<{ id: string; paged_at: number | null; replay_count: number }>()
  if (!row) throw new Error('ops_alerts upsert returned no row')
  const isNew = row.replay_count === 0
  const base = { alertId: row.id, source: source.id, severity: alert.severity }

  if (alert.severity !== 'page') {
    if (isNew) queueAlertMemory(source, alert, env, ctx)
    return { outcome: isNew ? 'noticed' : 'duplicate', ...base }
  }

  // Atomic claim BEFORE delivery (agent-finish claimDelivery pattern): exactly
  // one concurrent request wins the window; a sender retry after a transient
  // failure cannot double-page because the claim is the dedupe write.
  const windowMs = source.dedupe_window_s * 1000
  const claim = await env.D1_US.prepare(
    `UPDATE ops_alerts SET paged_at = ?
     WHERE id = ? AND (paged_at IS NULL OR paged_at <= ?)
     RETURNING id`,
  ).bind(now, row.id, now - windowMs).first<{ id: string }>()
  if (!claim) return { outcome: 'duplicate', ...base }

  const message = alert.body && alert.body !== alert.title
    ? `🚨 [${source.id}] ${alert.title}\n${alert.body}`
    : `🚨 [${source.id}] ${alert.title}`
  const delivery = await deliverOpsPage(source.tenant_id, message, env)

  if (!delivery.delivered) {
    // Release the claim so a retry (the webhook returns 503) can page.
    await env.D1_US.prepare(
      `UPDATE ops_alerts SET paged_at = NULL WHERE id = ? AND paged_at = ?`,
    ).bind(row.id, now).run().catch(() => {})
    if (isNew) queueAlertMemory(source, alert, env, ctx)
    return { outcome: 'page_failed', ...base }
  }

  ctx.waitUntil(env.D1_US.prepare(
    `UPDATE ops_alerts SET page_channel = ? WHERE id = ?`,
  ).bind(delivery.channel, row.id).run().catch(() => {}))
  if (isNew) queueAlertMemory(source, alert, env, ctx)
  return { outcome: 'paged', ...base }
}
