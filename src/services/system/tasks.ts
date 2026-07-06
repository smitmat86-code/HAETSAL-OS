// src/services/system/tasks.ts
// Phase 14: platform cron task toggles. scheduled_tasks rows were seeded at
// tenant bootstrap but never enforced — this module is now the single check
// the cron handlers call. Default is ENABLED when no row exists (including
// 'heartbeat', which predates no seed row).

import type { Env } from '../../types/env'
import { writeAuditLog } from '../../middleware/audit'

export const PLATFORM_TASKS: Array<{ name: string; title: string; schedule: string }> = [
  { name: 'morning_brief', title: 'Morning brief', schedule: 'Daily 7:00 am' },
  { name: 'consolidation_cron', title: 'Dream cycle (nightly consolidation)', schedule: 'Daily 2:00 am' },
  { name: 'weekly_synthesis', title: 'Weekly synthesis (dormant — handler is a no-op pending rebuild)', schedule: 'Friday 5:00 pm' },
  { name: 'heartbeat', title: 'Predictive heartbeat', schedule: 'Every 30 min, 8 am–8 pm' },
]

export async function isTaskEnabled(env: Env, tenantId: string, taskName: string): Promise<boolean> {
  try {
    const row = await env.D1_US.prepare(
      `SELECT enabled FROM scheduled_tasks WHERE tenant_id = ? AND task_name = ? LIMIT 1`,
    ).bind(tenantId, taskName).first<{ enabled: number }>()
    return row ? row.enabled === 1 : true
  } catch {
    return true // fail open: a metadata read error must never silence a cron
  }
}

export async function setTaskEnabled(
  env: Env, tenantId: string, taskName: string, enabled: boolean,
): Promise<void> {
  if (!PLATFORM_TASKS.some((t) => t.name === taskName)) throw new Error('UnknownTask')
  const now = Date.now()
  const updated = await env.D1_US.prepare(
    `UPDATE scheduled_tasks SET enabled = ?, updated_at = ? WHERE tenant_id = ? AND task_name = ?`,
  ).bind(enabled ? 1 : 0, now, tenantId, taskName).run()
  if (!updated.meta.changes) {
    await env.D1_US.prepare(
      `INSERT INTO scheduled_tasks
       (id, tenant_id, task_name, cron_expression, enabled, is_platform_default, description, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 1, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), tenantId, taskName, enabled ? 1 : 0,
      PLATFORM_TASKS.find((t) => t.name === taskName)?.title ?? taskName, now, now).run()
  }
  await writeAuditLog(env, enabled ? 'system.task_enabled' : 'system.task_disabled', tenantId, {
    agentIdentity: 'user', domain: taskName,
  })
}

export async function listTaskStates(
  env: Env, tenantId: string,
): Promise<Array<{ name: string; title: string; schedule: string; enabled: boolean }>> {
  const rows = await env.D1_US.prepare(
    `SELECT task_name, enabled FROM scheduled_tasks WHERE tenant_id = ?`,
  ).bind(tenantId).all<{ task_name: string; enabled: number }>()
  const byName = new Map((rows.results ?? []).map((r) => [r.task_name, r.enabled === 1]))
  return PLATFORM_TASKS.map((t) => ({ ...t, enabled: byName.get(t.name) ?? true }))
}
