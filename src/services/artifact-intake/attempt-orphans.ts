import type { Env } from '../../types/env'
import { managedArtifactAttemptR2Key } from './storage-keys'

export interface AttemptOwnershipRow {
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

export async function readAttemptOwnership(
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
