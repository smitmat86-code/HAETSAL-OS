// src/cron/dream.ts
// 2am cron entry for the Phase 8 dream cycle. Claims a per-tenant per-date
// run row (INSERT OR IGNORE dedup, same pattern as the retired consolidation
// orchestrator) and starts the durable Workflow. Replaces the parked
// pass-1..4 consolidation invocation.

import type { Env } from '../types/env'
import { claimDreamRun } from '../services/dream/report'

export async function handleDreamCron(env: Env, _ctx: ExecutionContext): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()
  if (!tenants.results?.length) return
  await Promise.allSettled(tenants.results.map(t => startDreamRun(t.id, 'cron', env)))
}

export async function startDreamRun(
  tenantId: string,
  trigger: 'cron' | 'manual',
  env: Env,
): Promise<{ runId: string; started: boolean }> {
  const runDate = new Date().toISOString().slice(0, 10)
  const runId = await claimDreamRun(env, tenantId, `${runDate}${trigger === 'manual' ? `-manual-${Date.now()}` : ''}`, trigger)
  if (!runId) return { runId: '', started: false }
  await env.DREAM_WORKFLOW.create({
    id: `dream-${runId}`,
    params: { tenantId, runId, runDate },
  })
  return { runId, started: true }
}
