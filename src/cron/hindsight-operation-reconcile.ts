import type { Env } from '../types/env'
import type { OperationStateRow, PendingOperationRow } from './hindsight-operation-types'
import { IMMEDIATE_RECONCILIATION_DELAYS_MS } from './hindsight-operation-types'
import { pollOperation } from './hindsight-operation-poll'

export async function reconcileHindsightOperation(
  operationId: string,
  env: Env,
): Promise<'missing' | 'pending' | 'settled'> {
  const row = await env.D1_US.prepare(
    `SELECT operation_id, tenant_id, bank_id, source_document_id, memory_type, domain, provenance,
            salience_tier, available_at, requested_at, slow_at, stuck_at
     FROM hindsight_operations
     WHERE operation_id = ?`,
  ).bind(operationId).first<PendingOperationRow & { status?: string }>()
  if (!row) return 'missing'

  const current = await readOperationState(operationId, env)
  if (!current) return 'missing'
  if (current.status !== 'pending' || current.available_at != null) return 'settled'

  await pollOperation(row, env)

  const refreshed = await readOperationState(operationId, env)
  if (!refreshed) return 'missing'
  return refreshed.status === 'pending' && refreshed.available_at == null ? 'pending' : 'settled'
}

export async function reconcileHindsightOperationSoon(
  operationId: string,
  env: Env,
): Promise<void> {
  for (const delayMs of IMMEDIATE_RECONCILIATION_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs)
    const state = await reconcileHindsightOperation(operationId, env)
    if (state !== 'pending') return
  }
}

async function readOperationState(
  operationId: string,
  env: Env,
): Promise<OperationStateRow | null> {
  return env.D1_US.prepare(
    `SELECT status, available_at
     FROM hindsight_operations
     WHERE operation_id = ?`,
  ).bind(operationId).first<OperationStateRow>()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
