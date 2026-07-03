import type { Env } from '../types/env'
import { reconcileCanonicalHindsightProjection } from './canonical-hindsight-reconcile'

export interface HindsightStatusRefreshRow {
  projection_kind: string
  status: string
  result_status: string | null
  engine_document_id: string | null
  engine_operation_id: string | null
  availability_source: string | null
}

function toUnixMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function refreshQueuedHindsightProjection(
  row: HindsightStatusRefreshRow,
  env: Env,
  tenantId: string,
): Promise<boolean> {
  if (row.projection_kind !== 'hindsight' || row.engine_operation_id == null) return false
  if (row.status !== 'queued' && row.result_status !== 'queued' && row.availability_source === 'document') {
    return false
  }

  // Lazy import: the Hindsight read stack pulls @cloudflare/containers, which
  // only resolves inside workerd. This refresh path serves historical data
  // only and is removed at the Phase 2 read cutover.
  const [{ fetchDocument, getOperationStatus }, { resolveHindsightBankId }] = await Promise.all([
    import('./hindsight'),
    import('./hindsight-transport'),
  ])
  const bankId = await resolveHindsightBankId(tenantId, env)
  const now = Date.now()
  let changed = false

  if (row.engine_document_id) {
    const document = await fetchDocument(bankId, row.engine_document_id, env).catch(() => null)
    if (document && document.memory_unit_count > 0) {
      const availableAt = toUnixMs(document.updated_at) ?? toUnixMs(document.created_at) ?? now
      const result = await env.D1_US.prepare(
        `UPDATE hindsight_operations
         SET available_at = COALESCE(available_at, ?),
             availability_source = 'document',
             availability_last_checked_at = ?,
             availability_error_message = NULL,
             updated_at = ?
         WHERE operation_id = ?
           AND (availability_source IS NULL OR availability_source != 'document')`,
      ).bind(availableAt, now, now, row.engine_operation_id).run()
      changed = changed || (result.meta.changes ?? 0) > 0
    }
  }

  const remoteOperation = await getOperationStatus(bankId, row.engine_operation_id, env).catch(() => null)
  if (!remoteOperation) return changed

  if (remoteOperation.status === 'completed') {
    const completedAt = toUnixMs(remoteOperation.completed_at) ?? toUnixMs(remoteOperation.updated_at) ?? now
    await env.D1_US.prepare(
      `UPDATE hindsight_operations
       SET status = 'completed',
           updated_at = ?,
           completed_at = COALESCE(completed_at, ?),
           last_checked_at = ?,
           availability_source = COALESCE(availability_source, 'operation_completed'),
           availability_last_checked_at = ?,
           availability_error_message = NULL,
           error_message = NULL
       WHERE operation_id = ?`,
    ).bind(
      toUnixMs(remoteOperation.updated_at) ?? now,
      completedAt,
      now,
      now,
      row.engine_operation_id,
    ).run()
    await reconcileCanonicalHindsightProjection(env, tenantId, row.engine_operation_id)
    return true
  }

  if (remoteOperation.status === 'failed' || remoteOperation.status === 'cancelled') {
    await env.D1_US.prepare(
      `UPDATE hindsight_operations
       SET status = 'failed',
           updated_at = ?,
           completed_at = COALESCE(completed_at, ?),
           last_checked_at = ?,
           error_message = ?
       WHERE operation_id = ?`,
    ).bind(
      toUnixMs(remoteOperation.updated_at) ?? now,
      toUnixMs(remoteOperation.completed_at) ?? now,
      now,
      remoteOperation.error_message ?? `Hindsight operation ${remoteOperation.status}`,
      row.engine_operation_id,
    ).run()
    await reconcileCanonicalHindsightProjection(env, tenantId, row.engine_operation_id)
    return true
  }

  return changed
}
