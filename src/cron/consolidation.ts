// src/cron/consolidation.ts
// Nightly consolidation orchestrator — 4 passes, webhook + cron entry
// LESSON: KEK expired → defer entire run, not fail
// LESSON: INSERT OR IGNORE for dedup — prevents webhook + cron double-run

import type { Env } from '../types/env'
import { fetchAndValidateKek } from './kek'
import { runPass1 } from './passes/pass1-contradiction'
import { runPass2 } from './passes/pass2-bridges'
import { runPass3 } from './passes/pass3-patterns'
import { runPass4 } from './passes/pass4-gaps'

/** Webhook-triggered entry — preferred path */
export async function runConsolidationPasses(
  hindsightTenantId: string, env: Env, ctx: ExecutionContext,
): Promise<void> {
  // Lookup tenant by hindsight_tenant_id
  const tenant = await env.D1_US.prepare(
    'SELECT id FROM tenants WHERE hindsight_tenant_id = ?',
  ).bind(hindsightTenantId).first<{ id: string }>()
  if (!tenant) return

  await runForTenant(tenant.id, hindsightTenantId, 'webhook', env, ctx)
}

/** Cron fallback — iterates all completed tenants */
export async function handleNightlyConsolidation(
  env: Env, ctx: ExecutionContext,
): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id, hindsight_tenant_id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string; hindsight_tenant_id: string }>()
  if (!tenants.results?.length) return

  await Promise.allSettled(
    tenants.results.map(t => runForTenant(t.id, t.hindsight_tenant_id, 'cron', env, ctx)),
  )
}

async function runForTenant(
  tenantId: string, hindsightTenantId: string,
  trigger: 'cron' | 'webhook', env: Env, _ctx: ExecutionContext,
): Promise<void> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) return // Deferred — anomaly already written by kek.ts

  const runId = crypto.randomUUID()
  const now = Date.now()

  // Dedup: INSERT OR IGNORE — unique index prevents same-day double-run
  const insertResult = await env.D1_US.prepare(
    `INSERT OR IGNORE INTO consolidation_runs
     (id, tenant_id, started_at, status, trigger)
     VALUES (?, ?, ?, 'running', ?)`,
  ).bind(runId, tenantId, now, trigger).run()

  // If INSERT was ignored (dedup), skip this tenant
  if (!insertResult.meta.changes) return

  try {
    // Passes run sequentially — each awaited before next
    const p1 = await runPass1(hindsightTenantId, kek, env)
    const p2 = await runPass2(hindsightTenantId, tenantId, kek, env)
    const p3 = await runPass3(hindsightTenantId, tenantId, kek, env)
    const p4 = await runPass4(hindsightTenantId, tenantId, runId, env)

    await env.D1_US.prepare(
      `UPDATE consolidation_runs
       SET status = 'completed', completed_at = ?,
           pass1_contradictions = ?, pass2_bridges = ?,
           pass3_patterns = ?, pass4_gaps = ?
       WHERE id = ?`,
    ).bind(Date.now(), p1, p2, p3, p4, runId).run()
  } catch (err) {
    await env.D1_US.prepare(
      `UPDATE consolidation_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`,
    ).bind(Date.now(), (err as Error).message?.slice(0, 500), runId).run()
  }
}
