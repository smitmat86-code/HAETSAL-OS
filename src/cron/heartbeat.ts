// src/cron/heartbeat.ts
// Predictive heartbeat — 30-min cadence, 8AM-8PM UTC only
// ONLY sends Telegram when something is actionable — silence is correct behavior
// LESSON: Pattern-first before LLM — D1 queries determine alerts, no AI call

import type { Env } from '../types/env'
import { sendTelegramMessage } from '../services/delivery/telegram'

export async function runPredictiveHeartbeat(
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const hour = new Date().getUTCHours()
  if (hour < 8 || hour >= 20) return

  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()

  if (!tenants.results?.length) return

  await Promise.allSettled(
    tenants.results.map(t => checkTenantHeartbeat(t.id, env)),
  )
}

async function checkTenantHeartbeat(
  tenantId: string, env: Env,
): Promise<void> {
  const alerts: string[] = []

  // Check 1: Pending actions > 20h old, still awaiting_approval
  const expiring = await env.D1_US.prepare(
    `SELECT action_type, integration FROM pending_actions
     WHERE tenant_id = ? AND state = 'awaiting_approval'
     AND proposed_at < ? ORDER BY proposed_at ASC LIMIT 3`,
  ).bind(tenantId, Date.now() - 20 * 60 * 60 * 1000).all()

  if (expiring.results?.length) {
    const items = expiring.results
      .map(a => `  ${a.action_type} via ${a.integration}`)
      .join('\n')
    alerts.push(`<b>Actions expiring soon:</b>\n${items}`)
  }

  // Check 2: > 2 unsurfaced high-priority consolidation gaps
  const gaps = await env.D1_US.prepare(
    `SELECT COUNT(*) as count FROM consolidation_gaps
     WHERE tenant_id = ? AND surfaced = 0 AND priority = 'high'`,
  ).bind(tenantId).first<{ count: number }>()

  if ((gaps?.count ?? 0) > 2) {
    alerts.push(`<b>${gaps!.count} open questions</b> from analysis — review when you have a moment.`)
  }

  // TODO: Phase 4+ — Check 3: No session today (requires session tracking in D1)

  if (alerts.length > 0) {
    await sendTelegramMessage(tenantId, alerts.join('\n\n'), env)
  }
}
