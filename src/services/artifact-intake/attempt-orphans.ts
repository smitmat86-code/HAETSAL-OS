import type { Env } from '../../types/env'
import { ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS } from './config'
import { managedArtifactAttemptR2Key } from './storage-keys'

interface AttemptOwnershipRow {
  status: string
  adopted_attempt_token: string | null
  upload_attempt_token: string | null
  upload_attempt_expires_at: number | null
}

/** Journalled before the R2 put so a crashed attempt stays findable. */
export async function recordUploadAttemptIntent(env: Env, args: {
  tenantId: string
  uploadId: string
  attemptToken: string
  leaseExpiresAt: number
  now: number
}): Promise<void> {
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO artifact_upload_attempts
     (tenant_id, upload_id, attempt_token, created_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(args.tenantId, args.uploadId, args.attemptToken, args.now, args.leaseExpiresAt).run()
}

export async function clearUploadAttemptIntent(
  env: Env, tenantId: string, uploadId: string, attemptToken: string,
): Promise<void> {
  await env.D1_US.prepare(
    `DELETE FROM artifact_upload_attempts
     WHERE tenant_id = ? AND upload_id = ? AND attempt_token = ?`,
  ).bind(tenantId, uploadId, attemptToken).run()
}

async function readAttemptOwnership(
  env: Env, tenantId: string, uploadId: string,
): Promise<AttemptOwnershipRow | null> {
  return env.D1_US.prepare(
    `SELECT status, adopted_attempt_token, upload_attempt_token, upload_attempt_expires_at
     FROM artifact_intake_operations WHERE tenant_id = ? AND upload_id = ? LIMIT 1`,
  ).bind(tenantId, uploadId).first<AttemptOwnershipRow>()
}

export type AttemptCleanupOutcome = 'deleted' | 'kept_adopted' | 'kept_live' | 'kept_indeterminate'

/**
 * Deletes exactly one losing attempt's unique object, and only after
 * authoritative D1 state proves that attempt was not adopted and can no
 * longer be adopted. Any read or delete failure keeps the object and its
 * journal row for the crash-safe sweeper: uncertainty never deletes.
 */
export async function cleanupLosingUploadAttempt(env: Env, args: {
  tenantId: string
  uploadId: string
  attemptToken: string
  /** 'lost' = the adoption CAS definitively changed zero rows; 'ambiguous' = its response was indeterminate. */
  mode: 'lost' | 'ambiguous'
}): Promise<AttemptCleanupOutcome> {
  let row: AttemptOwnershipRow | null
  try {
    row = await readAttemptOwnership(env, args.tenantId, args.uploadId)
  } catch {
    return 'kept_indeterminate'
  }
  if (!row) return 'kept_indeterminate'
  if (row.adopted_attempt_token === args.attemptToken) return 'kept_adopted'
  if (args.mode === 'ambiguous') {
    // The attempt's own adoption outcome is unknown. It is provably decided
    // against this attempt only once another identity was adopted or the
    // operation left the adoptable states; otherwise keep everything.
    const decidedAgainst = (row.status === 'sealed' || row.status === 'finalized' || row.status === 'expired')
      && row.adopted_attempt_token !== args.attemptToken
    if (!decidedAgainst) return 'kept_indeterminate'
  }
  try {
    const key = await managedArtifactAttemptR2Key(args.tenantId, args.uploadId, args.attemptToken)
    await env.R2_ARTIFACTS.delete(key)
    await clearUploadAttemptIntent(env, args.tenantId, args.uploadId, args.attemptToken)
    return 'deleted'
  } catch {
    return 'kept_indeterminate'
  }
}

export interface AttemptSweepResult {
  inspected: number
  deleted: number
  keptAdopted: number
  keptLive: number
  indeterminate: number
}

/**
 * Bounded crash-safe sweep of abandoned attempt journals. Eligibility
 * requires the attempt lease plus a full write-lifetime grace window to have
 * elapsed, so no eligible attempt can still be writing and a late R2 put can
 * no longer land after its journal row is retired. The adopted attempt's
 * object is never deleted; its journal row alone is retired.
 */
export async function sweepAbandonedArtifactUploadAttempts(
  env: Env,
  now = Date.now(),
  limit = 50,
): Promise<AttemptSweepResult> {
  const result: AttemptSweepResult = {
    inspected: 0, deleted: 0, keptAdopted: 0, keptLive: 0, indeterminate: 0,
  }
  const rows = await env.D1_US.prepare(
    `SELECT tenant_id, upload_id, attempt_token FROM artifact_upload_attempts
     WHERE lease_expires_at <= ? ORDER BY lease_expires_at ASC LIMIT ?`,
  ).bind(now - ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS, limit)
    .all<{ tenant_id: string; upload_id: string; attempt_token: string }>()
  for (const row of rows.results) {
    result.inspected += 1
    let ownership: AttemptOwnershipRow | null
    try {
      ownership = await readAttemptOwnership(env, row.tenant_id, row.upload_id)
    } catch {
      result.indeterminate += 1
      continue
    }
    if (!ownership) {
      result.indeterminate += 1
      continue
    }
    if (ownership.adopted_attempt_token === row.attempt_token) {
      await clearUploadAttemptIntent(env, row.tenant_id, row.upload_id, row.attempt_token)
      result.keptAdopted += 1
      continue
    }
    if (
      ownership.upload_attempt_token === row.attempt_token &&
      Number(ownership.upload_attempt_expires_at ?? 0) > now
    ) {
      result.keptLive += 1
      continue
    }
    try {
      const key = await managedArtifactAttemptR2Key(row.tenant_id, row.upload_id, row.attempt_token)
      await env.R2_ARTIFACTS.delete(key)
      await clearUploadAttemptIntent(env, row.tenant_id, row.upload_id, row.attempt_token)
      result.deleted += 1
    } catch {
      result.indeterminate += 1
    }
  }
  return result
}
