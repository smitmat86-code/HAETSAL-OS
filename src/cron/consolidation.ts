// src/cron/consolidation.ts
// Nightly consolidation orchestrator — 4 passes, cron entry
// LESSON: KEK expired → defer entire run, not fail
// LESSON: INSERT OR IGNORE for dedup — prevents double-run
// NOTE: hindsight webhook entry removed in mission Phase 3 (engine retired)

import type { Env } from '../types/env'
import { fetchAndValidateKek } from './kek'
import { runPass1 } from './passes/pass1-contradiction'
import { runPass2 } from './passes/pass2-bridges'
import { runPass3 } from './passes/pass3-patterns'
import { runPass4 } from './passes/pass4-gaps'

/** Cron fallback — iterates all completed tenants */
export async function handleNightlyConsolidation(
  env: Env, ctx: ExecutionContext,
): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()
  if (!tenants.results?.length) return

  await Promise.allSettled(
    tenants.results.map(t => runForTenant(t.id, 'cron', env, ctx)),
  )
}

async function runForTenant(
  tenantId: string,
  trigger: 'cron', env: Env, _ctx: ExecutionContext,
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
    // Pass 1 and 2 previously received hindsightTenantId; now pass tenantId (engine retired Phase 3)
    const p1 = await runPass1(tenantId, kek, env)
    const p2 = await runPass2(tenantId, tenantId, kek, env)
    const p3 = await runPass3(tenantId, tenantId, kek, env)
    const p4 = await runPass4(tenantId, tenantId, runId, env)

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
