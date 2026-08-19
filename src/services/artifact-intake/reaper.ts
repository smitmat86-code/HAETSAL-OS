import type { Env } from '../../types/env'
import { sweepAbandonedArtifactUploadAttempts } from './attempt-orphans'
import { ARTIFACT_EXPIRY_CLAIM_LEASE_MS } from './config'
import type { ArtifactIntakeOperationRow } from './operations'
import { recoverOrFailStaleArtifactFinalizations } from './stale-finalization-recovery'
import { deleteProvenManagedArtifact } from './storage'

export interface ArtifactReaperResult {
  inspected: number
  reaped: number
  repairedFinalized: number
  failed: number
  deferred: number
  integrityIncidents: number
  orphanAttemptsDeleted: number
}

export async function reapExpiredArtifactUploads(
  env: Env,
  now = Date.now(),
  limit = 100,
): Promise<ArtifactReaperResult> {
  const result: ArtifactReaperResult = {
    inspected: 0,
    reaped: 0,
    repairedFinalized: 0,
    failed: 0,
    deferred: 0,
    integrityIncidents: 0,
    orphanAttemptsDeleted: 0,
  }
  const orphanSweep = await sweepAbandonedArtifactUploadAttempts(env, now, limit)
  result.orphanAttemptsDeleted += orphanSweep.deleted
  const stale = await recoverOrFailStaleArtifactFinalizations(env, now, limit)
  result.failed += stale.failed
  result.repairedFinalized += stale.repairedFinalized
  result.deferred += stale.deferred
  result.integrityIncidents += stale.integrityIncidents
  const rows = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations o
     WHERE o.status IN ('reserved', 'sealed', 'failed') AND o.expires_at <= ?
       AND (o.expiry_claim_token IS NULL OR o.expiry_claim_expires_at <= ?)
       AND NOT EXISTS (
         SELECT 1 FROM artifact_intake_finalizations f
          WHERE f.tenant_id = o.tenant_id AND f.id = o.finalization_id
            AND (f.status IN ('reserved', 'finalized') OR f.lease_expires_at > ?)
       )
     ORDER BY o.expires_at ASC LIMIT ?`,
  ).bind(now, now, now, limit).all<ArtifactIntakeOperationRow>()
  for (const row of rows.results) {
    result.inspected += 1
    const claimToken = crypto.randomUUID()
    try {
      const claimed = await env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET expiry_claim_token = ?, expiry_claim_expires_at = ?, updated_at = ?
         WHERE tenant_id = ? AND upload_id = ?
           AND status IN ('reserved', 'sealed', 'failed') AND expires_at <= ?
           AND (expiry_claim_token IS NULL OR expiry_claim_expires_at <= ?)
           AND (upload_attempt_token IS NULL OR upload_attempt_expires_at <= ?)
           AND (finalization_protected_until IS NULL OR finalization_protected_until <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM artifact_intake_finalizations f
             WHERE f.tenant_id = artifact_intake_operations.tenant_id
                AND f.id = artifact_intake_operations.finalization_id
                AND (f.status IN ('reserved', 'finalized') OR f.lease_expires_at > ?)
           )`,
      ).bind(
        claimToken, now + ARTIFACT_EXPIRY_CLAIM_LEASE_MS, now,
        row.tenant_id, row.upload_id, now, now, now, now, now,
      ).run()
      if (Number(claimed.meta.changes ?? 0) !== 1) continue

      await deleteProvenManagedArtifact({
        env,
        tenantId: row.tenant_id,
        uploadId: row.upload_id,
        recordedKey: row.r2_key,
        adoptedAttemptToken: row.adopted_attempt_token,
        expectedCiphertextSha256: row.ciphertext_sha256,
        expectedCiphertextByteLength: row.ciphertext_byte_length,
      })
      // Canonical document bodies are never deleted here: an expired artifact
      // operation's stale canonical pointer is not proof the body is orphaned.
      // Orphaned canonical bodies require a separate proof-backed process.
      const expired = await env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET status = 'expired', error_code = NULL, expiry_claim_expires_at = NULL, updated_at = ?
         WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized' AND expiry_claim_token = ?`,
      ).bind(now, row.tenant_id, row.upload_id, claimToken).run()
      if (Number(expired.meta.changes ?? 0) !== 1) throw new Error('artifact expiry claim lost')
      result.reaped += 1
    } catch {
      // The claim remains. Once its short lease expires, a later reaper retries
      // the exact proof/delete operation; finalization can never steal it.
      result.failed += 1
    }
  }
  return result
}
