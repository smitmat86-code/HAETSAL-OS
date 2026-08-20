import type { Env } from '../../types/env'
import { ARTIFACT_FINALIZATION_RECOVERY_MS } from './config'
import { ARTIFACT_INTAKE_ERROR } from './contracts'
import type { ArtifactFinalizationRow } from './finalize'
import { proveArtifactFinalizationCanonicalSuccess } from './finalization-proof'
import {
  acquireArtifactFinalizationLease,
  failArtifactFinalizationAndReleaseOperations,
  markArtifactOperationsFinalized,
} from './operations'
import {
  deferOrProtect,
  loadProofOperations,
  type StaleArtifactFinalizationRecoveryResult,
} from './stale-finalization-support'

export type { StaleArtifactFinalizationRecoveryResult } from './stale-finalization-support'

export async function recoverOrFailStaleArtifactFinalizations(
  env: Env,
  now: number,
  limit: number,
): Promise<StaleArtifactFinalizationRecoveryResult> {
  const result: StaleArtifactFinalizationRecoveryResult = {
    failed: 0, repairedFinalized: 0, deferred: 0, integrityIncidents: 0,
  }
  let stale
  try {
    stale = await env.D1_US.prepare(
      `SELECT * FROM artifact_intake_finalizations
       WHERE status = 'reserved' AND COALESCE(recovery_expires_at, updated_at + ?) <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY COALESCE(recovery_expires_at, updated_at + ?) ASC LIMIT ?`,
    ).bind(ARTIFACT_FINALIZATION_RECOVERY_MS, now, now, ARTIFACT_FINALIZATION_RECOVERY_MS, limit)
      .all<ArtifactFinalizationRow>()
  } catch {
    result.deferred += 1
    return result
  }

  for (const finalization of stale.results) {
    const loaded = await loadProofOperations(finalization, env)
    const operations = loaded.operations ?? []
    const proof = loaded.proof ?? await proveArtifactFinalizationCanonicalSuccess({
      finalization, operations, env,
    })
    if (proof.status === 'indeterminate') {
      deferOrProtect(proof, finalization.id, result)
      continue
    }
    if (proof.status === 'authoritative_mismatch') {
      const failed = await failArtifactFinalizationAndReleaseOperations({
        tenantId: finalization.tenant_id, finalizationId: finalization.id,
        errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED, now,
      }, env).catch(() => false)
      if (failed) result.failed += 1
      else result.integrityIncidents += 1
      continue
    }

    const leaseOwner = crypto.randomUUID()
    try {
      await acquireArtifactFinalizationLease({
        tenantId: finalization.tenant_id, finalizationId: finalization.id, leaseOwner,
        expectedOperationCount: operations.length,
        captureId: finalization.canonical_capture_id,
        documentId: finalization.canonical_document_id,
        operationId: finalization.canonical_operation_id,
        now, allowExpiredRecoveryProof: true,
      }, env)
    } catch {
      result.deferred += 1
      continue
    }

    const repeated = await proveArtifactFinalizationCanonicalSuccess({ finalization, operations, env })
    if (repeated.status === 'indeterminate') {
      deferOrProtect(repeated, finalization.id, result)
      continue
    }
    if (repeated.status === 'authoritative_mismatch') {
      // Proof changed while owned. Preserve every binding and byte for an
      // integrity investigation; never turn the reservation into reaper fuel.
      result.integrityIncidents += 1
      continue
    }

    try {
      await markArtifactOperationsFinalized({
        tenantId: finalization.tenant_id, finalizationId: finalization.id, leaseOwner,
        operations,
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
      if (Number(completed.meta.changes ?? 0) === 1) {
        result.repairedFinalized += 1
        continue
      }
      const reread = await env.D1_US.prepare(
        `SELECT status FROM artifact_intake_finalizations
         WHERE tenant_id = ? AND id = ? LIMIT 1`,
      ).bind(finalization.tenant_id, finalization.id).first<{ status: string }>()
      if (reread?.status === 'finalized') result.repairedFinalized += 1
      else result.deferred += 1
    } catch {
      // Child-finalized/parent-reserved is a protected, recoverable split.
      // A later pass re-proves it; failure is never rewritten over success.
      result.deferred += 1
    }
  }
  return result
}
