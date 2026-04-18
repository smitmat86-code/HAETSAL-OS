// Poll async Hindsight retain operations and advance HAETSAL's local lifecycle state.
// Baseline completion path is polling; webhook support can layer on later.

import type { Env } from '../types/env'
import { ensureHindsightWorkersRunning } from '../services/hindsight'
import { pollOperation } from './hindsight-operation-poll'
import type { PendingOperationRow } from './hindsight-operation-types'
import { MAX_POLLS_PER_TICK, MIN_RECHECK_MS } from './hindsight-operation-types'

export {
  reconcileHindsightOperation,
  reconcileHindsightOperationSoon,
} from './hindsight-operation-reconcile'

export async function handleHindsightOperationsTick(
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await ensureHindsightWorkersRunning(env).catch((error) => {
    console.error('HINDSIGHT_WORKER_PREWARM_FAILED', error)
  })

  const cutoff = Date.now() - MIN_RECHECK_MS
  const pending = await env.D1_US.prepare(
    `SELECT operation_id, tenant_id, bank_id, source_document_id, memory_type, domain, provenance,
            salience_tier, available_at, requested_at, slow_at, stuck_at
     FROM hindsight_operations
     WHERE status = 'pending'
       AND (last_checked_at IS NULL OR last_checked_at < ?)
     ORDER BY requested_at ASC
     LIMIT ?`,
  ).bind(cutoff, MAX_POLLS_PER_TICK).all<PendingOperationRow>()

  if (!pending.results?.length) return

  await Promise.allSettled(pending.results.map((row) => pollOperation(row, env)))
}
