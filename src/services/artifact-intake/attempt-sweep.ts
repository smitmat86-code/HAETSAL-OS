import type { Env } from '../../types/env'
import { ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS } from './config'
import {
  clearUploadAttemptIntent,
  readAttemptOwnership,
} from './attempt-orphans'
import { managedArtifactAttemptR2Key } from './storage-keys'

interface AttemptJournalRow {
  tenant_id: string
  upload_id: string
  attempt_token: string
  resolved_at: number | null
}

export interface AttemptSweepResult {
  inspected: number
  deleted: number
  retired: number
  pending: number
  keptAdopted: number
  keptLive: number
  indeterminate: number
}

/**
 * Bounded tombstone sweep of abandoned attempt journals. An HTTP-triggered
 * Worker has no hard wall-time limit, so a journalled attempt's R2 put may
 * land arbitrarily late; the grace window only paces the first re-check and
 * is never treated as proof the put is dead. A journal row is retired ONLY
 * when its attempt was adopted (the object is canonical and never deleted
 * here), or when an object at the exact derived key was actually observed
 * and deleted (resolved_at) and a later sweep re-confirms absence. Absence
 * during a single check merely stamps the tombstone (swept_at/sweep_count)
 * and keeps the durable pointer, so a late put is always found and deleted
 * by a later sweep. Every pass is idempotent, does bounded work, and reads
 * zero object bodies.
 */
export async function sweepAbandonedArtifactUploadAttempts(
  env: Env,
  now = Date.now(),
  limit = 50,
): Promise<AttemptSweepResult> {
  const result: AttemptSweepResult = {
    inspected: 0, deleted: 0, retired: 0, pending: 0,
    keptAdopted: 0, keptLive: 0, indeterminate: 0,
  }
  const rows = await env.D1_US.prepare(
    `SELECT tenant_id, upload_id, attempt_token, resolved_at FROM artifact_upload_attempts
     WHERE lease_expires_at <= ?
     ORDER BY (swept_at IS NOT NULL) ASC, swept_at ASC, lease_expires_at ASC LIMIT ?`,
  ).bind(now - ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS, limit)
    .all<AttemptJournalRow>()
  for (const row of rows.results) {
    result.inspected += 1
    try {
      await sweepOneAttempt(env, row, now, result)
    } catch {
      // D1/R2 ambiguity keeps the tombstone and the object: never delete or
      // retire cleanup state on uncertainty.
      result.indeterminate += 1
    }
  }
  return result
}

async function sweepOneAttempt(
  env: Env,
  row: AttemptJournalRow,
  now: number,
  result: AttemptSweepResult,
): Promise<void> {
  const ownership = await readAttemptOwnership(env, row.tenant_id, row.upload_id)
  if (!ownership) {
    result.indeterminate += 1
    return
  }
  if (ownership.adopted_attempt_token === row.attempt_token) {
    await clearUploadAttemptIntent(env, row.tenant_id, row.upload_id, row.attempt_token)
    result.keptAdopted += 1
    return
  }
  if (
    ownership.upload_attempt_token === row.attempt_token &&
    Number(ownership.upload_attempt_expires_at ?? 0) > now
  ) {
    result.keptLive += 1
    return
  }
  const key = await managedArtifactAttemptR2Key(row.tenant_id, row.upload_id, row.attempt_token)
  const object = await env.R2_ARTIFACTS.head(key)
  if (object) {
    // The (single logical) put for this attempt token has landed. Delete the
    // exact key, then keep the tombstone until a later sweep confirms the
    // deletion stuck: retirement never rests on one observation.
    await env.R2_ARTIFACTS.delete(key)
    await markAttemptTombstone(env, row, now, now)
    result.deleted += 1
    return
  }
  if (row.resolved_at !== null) {
    // A prior sweep observed and deleted the object and this sweep confirms
    // absence; only now is the pointer no longer needed.
    await clearUploadAttemptIntent(env, row.tenant_id, row.upload_id, row.attempt_token)
    result.retired += 1
    return
  }
  // No object has ever been observed: the put may still land arbitrarily
  // late. Stamp the tombstone and keep the durable pointer.
  await markAttemptTombstone(env, row, now, null)
  result.pending += 1
}

async function markAttemptTombstone(
  env: Env,
  row: AttemptJournalRow,
  now: number,
  resolvedAt: number | null,
): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE artifact_upload_attempts
     SET swept_at = ?, sweep_count = sweep_count + 1,
         resolved_at = COALESCE(?, resolved_at)
     WHERE tenant_id = ? AND upload_id = ? AND attempt_token = ?`,
  ).bind(now, resolvedAt, row.tenant_id, row.upload_id, row.attempt_token).run()
}
