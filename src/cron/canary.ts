// src/cron/canary.ts
// Phase 13 canary cron: runs the six-probe sweep hourly (piggybacking the
// 15-minute slot with a top-of-hour check) for every completed tenant.
// Probe failures are recorded, never thrown — canaries observe, not disrupt.

import type { Env } from '../types/env'
import { runCanarySweep } from '../services/canary/sweep'

export async function runCanaryCron(env: Env): Promise<void> {
  if (new Date().getUTCMinutes() >= 15) return // top-of-hour tick only
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()
  if (!tenants.results?.length) return
  await Promise.allSettled(tenants.results.map(t => runCanarySweep(env, t.id)))
}
