import { fetchDocument } from '../services/hindsight'
import {
  HINDSIGHT_PENDING_SLOW_MS,
  HINDSIGHT_PENDING_STUCK_MS,
} from '../services/hindsight-ops'
import type { Env } from '../types/env'
import type { PendingOperationRow } from './hindsight-operation-types'
import { MIN_AVAILABILITY_RECHECK_MS } from './hindsight-operation-types'

export function toUnixMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function markPendingPressure(
  row: PendingOperationRow,
  env: Env,
  now: number,
): Promise<void> {
  const actions: D1PreparedStatement[] = []
  const age = now - row.requested_at
  if (row.slow_at == null && age >= HINDSIGHT_PENDING_SLOW_MS) {
    actions.push(
      env.D1_US.prepare(
        `UPDATE hindsight_operations
         SET slow_at = ?, updated_at = ?
         WHERE operation_id = ?
           AND slow_at IS NULL`,
      ).bind(now, now, row.operation_id),
      env.D1_US.prepare(
        `INSERT INTO memory_audit
         (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
         VALUES (?, ?, ?, 'memory.retain_delayed', ?, ?, ?, ?, ?)`,
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
    )
  }

  if (row.stuck_at == null && age >= HINDSIGHT_PENDING_STUCK_MS) {
    actions.push(
      env.D1_US.prepare(
        `UPDATE hindsight_operations
         SET stuck_at = ?, updated_at = ?
         WHERE operation_id = ?
           AND stuck_at IS NULL`,
      ).bind(now, now, row.operation_id),
      env.D1_US.prepare(
        `INSERT INTO memory_audit
         (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
         VALUES (?, ?, ?, 'memory.retain_stuck', ?, ?, ?, ?, ?)`,
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
    )
  }

  if (actions.length > 0) {
    await env.D1_US.batch(actions)
  }
}

export async function markOperationAvailable(
  row: PendingOperationRow,
  env: Env,
  now: number,
): Promise<void> {
  if (!row.source_document_id) return
  try {
    const existing = await env.D1_US.prepare(
      `SELECT available_at, availability_last_checked_at
       FROM hindsight_operations
       WHERE operation_id = ?`,
    ).bind(row.operation_id).first<{
      available_at: number | null
      availability_last_checked_at: number | null
    }>()

    if (existing?.available_at != null) return
    if (existing?.availability_last_checked_at != null &&
      existing.availability_last_checked_at > now - MIN_AVAILABILITY_RECHECK_MS) {
      return
    }

    const document = await fetchDocument(row.bank_id, row.source_document_id, env)
    if (!document || document.memory_unit_count <= 0) {
      await env.D1_US.prepare(
        `UPDATE hindsight_operations
         SET availability_last_checked_at = ?, availability_error_message = NULL
         WHERE operation_id = ?`,
      ).bind(now, row.operation_id).run()
      return
    }

    const update = await env.D1_US.prepare(
      `UPDATE hindsight_operations
       SET available_at = ?,
           availability_source = 'document',
           availability_last_checked_at = ?,
           availability_error_message = NULL,
           updated_at = ?
       WHERE operation_id = ?
         AND available_at IS NULL`,
    ).bind(now, now, now, row.operation_id).run()

    if ((update.meta.changes ?? 0) > 0) {
      await env.D1_US.prepare(
        `INSERT INTO memory_audit
         (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
         VALUES (?, ?, ?, 'memory.retain_available', ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        row.tenant_id,
        now,
        row.source_document_id,
        row.memory_type,
        row.domain,
        row.provenance,
        row.salience_tier,
      ).run()
    }
  } catch (error) {
    await env.D1_US.prepare(
      `UPDATE hindsight_operations
       SET availability_last_checked_at = ?, availability_error_message = ?
       WHERE operation_id = ?`,
    ).bind(
      now,
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      row.operation_id,
    ).run()
  }
}
