import type { Env } from '../types/env'
import { reconcileCanonicalHindsightProjection } from '../services/canonical-hindsight-reconcile'
import { getOperationStatus } from '../services/hindsight'
import type { PendingOperationRow } from './hindsight-operation-types'
import { markOperationAvailable, markPendingPressure, toUnixMs } from './hindsight-operation-side-effects'

export async function pollOperation(
  row: PendingOperationRow,
  env: Env,
): Promise<void> {
  const now = Date.now()

  try {
    const availabilityPromise =
      row.source_document_id && row.available_at == null
        ? markOperationAvailable(row, env, now)
        : Promise.resolve()
    const pressurePromise = markPendingPressure(row, env, now)
    const status = await getOperationStatus(row.bank_id, row.operation_id, env)
    await availabilityPromise
    await pressurePromise

    if (status.status === 'pending') {
      await env.D1_US.prepare(
        `UPDATE hindsight_operations
         SET updated_at = ?, last_checked_at = ?, error_message = NULL
         WHERE operation_id = ?`,
      ).bind(now, now, row.operation_id).run()
      return
    }

    if (status.status === 'completed') {
      const completedAt = toUnixMs(status.completed_at) ?? now
      const completionSource = row.available_at == null ? 'operation_completed' : 'document'
      await env.D1_US.batch([
        env.D1_US.prepare(
          `UPDATE hindsight_operations
           SET status = 'completed',
               updated_at = ?,
               completed_at = ?,
               last_checked_at = ?,
               available_at = COALESCE(available_at, ?),
               availability_source = COALESCE(availability_source, ?),
               availability_last_checked_at = ?,
               availability_error_message = NULL,
               error_message = NULL
           WHERE operation_id = ?`,
        ).bind(
          toUnixMs(status.updated_at) ?? now,
          completedAt,
          now,
          completedAt,
          completionSource,
          now,
          row.operation_id,
        ),
        env.D1_US.prepare(
          `INSERT INTO memory_audit
           (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
           VALUES (?, ?, ?, 'memory.retain_completed', ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          row.tenant_id,
          now,
          row.source_document_id,
          row.memory_type,
          row.domain,
          row.provenance,
          row.salience_tier,
        ),
      ])
      await reconcileCanonicalHindsightProjection(env, row.tenant_id, row.operation_id)
      return
    }

    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE hindsight_operations
         SET status = 'failed', updated_at = ?, completed_at = ?, last_checked_at = ?, error_message = ?
         WHERE operation_id = ?`,
      ).bind(
        toUnixMs(status.updated_at) ?? now,
        toUnixMs(status.completed_at) ?? now,
        now,
        status.error_message ?? `Hindsight operation ${status.status}`,
        row.operation_id,
      ),
      env.D1_US.prepare(
        `INSERT INTO memory_audit
         (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
         VALUES (?, ?, ?, 'memory.retain_failed', ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        row.tenant_id,
        now,
        row.source_document_id,
        row.memory_type,
        row.domain,
        row.provenance,
        row.salience_tier,
      ),
    ])
    await reconcileCanonicalHindsightProjection(env, row.tenant_id, row.operation_id)
  } catch (error) {
    await env.D1_US.prepare(
      `UPDATE hindsight_operations
       SET updated_at = ?, last_checked_at = ?, error_message = ?
       WHERE operation_id = ?`,
    ).bind(
      now,
      now,
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      row.operation_id,
    ).run()
  }
}
