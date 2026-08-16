import type { Env } from '../../types/env'
import { ARTIFACT_FINALIZATION_RECOVERY_MS } from './config'
import { ARTIFACT_INTAKE_ERROR } from './contracts'
import type { ArtifactFinalizationRow } from './finalize'
import { proveArtifactFinalizationCanonicalSuccess } from './finalization-proof'
import {
  acquireArtifactFinalizationLease,
  failArtifactFinalizationAndReleaseOperations,
  loadArtifactOperationsForFinalization,
  markArtifactOperationsFinalized,
  type ArtifactIntakeOperationRow,
} from './operations'

export async function recoverOrFailStaleArtifactFinalizations(
  env: Env,
  now: number,
  limit: number,
): Promise<{ failed: number; repairedFinalized: number }> {
  const stale = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_finalizations
     WHERE status = 'reserved' AND COALESCE(recovery_expires_at, updated_at + ?) <= ?
     ORDER BY COALESCE(recovery_expires_at, updated_at + ?) ASC LIMIT ?`,
  ).bind(ARTIFACT_FINALIZATION_RECOVERY_MS, now, ARTIFACT_FINALIZATION_RECOVERY_MS, limit)
    .all<ArtifactFinalizationRow>()
  let failed = 0
  let repairedFinalized = 0
  for (const finalization of stale.results) {
    let operations: ArtifactIntakeOperationRow[] = []
    try {
      operations = await loadArtifactOperationsForFinalization({
        tenantId: finalization.tenant_id, finalizationId: finalization.id,
        expectedOperationCount: Number(finalization.expected_operation_count),
      }, env)
    } catch {
      operations = []
    }
    if (await proveArtifactFinalizationCanonicalSuccess({ finalization, operations, env })) {
      const leaseOwner = crypto.randomUUID()
      let ownsLease = false
      try {
        await acquireArtifactFinalizationLease({
          tenantId: finalization.tenant_id, finalizationId: finalization.id, leaseOwner,
          expectedOperationCount: operations.length,
          captureId: finalization.canonical_capture_id,
          documentId: finalization.canonical_document_id,
          operationId: finalization.canonical_operation_id,
          now, allowExpiredRecoveryProof: true,
        }, env)
        ownsLease = true
        if (!await proveArtifactFinalizationCanonicalSuccess({ finalization, operations, env })) {
          throw new Error('raw artifact proof changed during stale repair')
        }
        await markArtifactOperationsFinalized({
          tenantId: finalization.tenant_id, finalizationId: finalization.id, leaseOwner,
          uploadIds: operations.map(row => row.upload_id),
          captureId: finalization.canonical_capture_id,
          documentId: finalization.canonical_document_id,
          operationId: finalization.canonical_operation_id, now,
        }, env)
        const completed = await env.D1_US.prepare(
          `UPDATE artifact_intake_finalizations
           SET status = 'finalized', error_code = NULL, lease_owner = NULL,
               lease_expires_at = NULL, recovery_expires_at = NULL, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND status = 'reserved'
             AND lease_owner = ? AND lease_expires_at > ?`,
        ).bind(now, finalization.tenant_id, finalization.id, leaseOwner, now).run()
        if (Number(completed.meta.changes ?? 0) !== 1) throw new Error('stale repair lease lost')
        repairedFinalized += 1
        continue
      } catch {
        if (ownsLease) await failArtifactFinalizationAndReleaseOperations({
          tenantId: finalization.tenant_id, finalizationId: finalization.id,
          errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE, expectedLeaseOwner: leaseOwner, now,
        }, env).catch(() => undefined)
        continue
      }
    }
    if (await failArtifactFinalizationAndReleaseOperations({
      tenantId: finalization.tenant_id, finalizationId: finalization.id,
      errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED, now,
    }, env)) failed += 1
  }
  return { failed, repairedFinalized }
}
