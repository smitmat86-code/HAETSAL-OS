import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import type { ArtifactFinalizationRow } from '../artifact-intake/finalize'
import {
  markArtifactOperationsFinalizedForCompletedFinalization, type ArtifactIntakeOperationRow,
} from '../artifact-intake/operations'
import { ARTIFACT_FINALIZATION_RECOVERY_MS } from '../artifact-intake/config'
import { channelMediaRetrySeconds } from './claim-outcome'
import { proveChannelCanonicalSuccess } from './canonical-proof'
import { repairChannelMediaFinalized } from './job-transitions'
import {
  completeReservedFinalization, failStaleFinalization, finalizationFor,
  loadChannelFinalizationOperations, type ChannelMediaCanonicalRecoveryResult,
} from './canonical-recovery-support'
export type { ChannelMediaCanonicalRecoveryResult } from './canonical-recovery-support'

/** Repair D1/channel success only after exact canonical and managed-R2 proof. */
export async function recoverFinalizedChannelMediaJob(
  job: ChannelMediaJob,
  env: Env,
): Promise<ChannelMediaCanonicalRecoveryResult> {
  let finalization: ArtifactFinalizationRow | null
  try {
    finalization = await finalizationFor(job, env)
  } catch {
    return { status: 'in_progress', retryAfterSeconds: 1 }
  }
  if (!finalization) return { status: 'stably_absent' }

  const now = Date.now()
  const recoveryDeadline = finalization.recovery_expires_at === null
    ? Number(finalization.updated_at) + ARTIFACT_FINALIZATION_RECOVERY_MS
    : Number(finalization.recovery_expires_at)
  if (finalization.lease_expires_at !== null && Number(finalization.lease_expires_at) > now) {
    return {
      status: 'in_progress',
      retryAfterSeconds: channelMediaRetrySeconds(Number(finalization.lease_expires_at), now),
    }
  }

  const operations = await loadChannelFinalizationOperations(job, finalization, env)
  if (!operations) return { status: 'in_progress', retryAfterSeconds: 1 }

  const expectedOperationCount = Number(finalization.expected_operation_count)
  const operation = operations[0]
  if (!operation || operations.length !== 1 || operations.length !== expectedOperationCount) {
    if (finalization.status === 'finalized' || operations.some(row => row.status === 'finalized')) {
      console.error('ARTIFACT_INTEGRITY_INCIDENT', {
        reason: 'operation_set_mismatch', finalizationId: finalization.id,
      })
      return {
        status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE,
        protectedFinalizedHistory: true,
      }
    }
    return finalization.status === 'failed'
      ? {
          status: 'failed',
          errorCode: finalization.error_code ?? ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED,
        }
      : recoveryDeadline <= now
        ? failStaleFinalization(finalization, env, now)
        : { status: 'in_progress', retryAfterSeconds: channelMediaRetrySeconds(recoveryDeadline, now) }
  }
  const proof = await proveChannelCanonicalSuccess({ job, finalization, operation, env })
  if (proof.status === 'indeterminate') {
    return { status: 'in_progress', retryAfterSeconds: 1 }
  }
  if (proof.status === 'authoritative_mismatch') {
    if (finalization.status === 'finalized' || operation.status === 'finalized') {
      console.error('ARTIFACT_INTEGRITY_INCIDENT', {
        reason: proof.reason, finalizationId: finalization.id,
      })
      return {
        status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE,
        protectedFinalizedHistory: true,
      }
    }
    if (finalization.status === 'failed') return {
      status: 'failed',
      errorCode: finalization.error_code ?? ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED,
    }
    if (proof.reason === 'canonical_record_missing') return { status: 'stably_absent' }
    return recoveryDeadline <= now
      ? failStaleFinalization(finalization, env, now)
      : { status: 'in_progress', retryAfterSeconds: channelMediaRetrySeconds(recoveryDeadline, now) }
  }

  if (finalization.status === 'reserved') {
    const completion = await completeReservedFinalization({
      job, finalization, operation, recoveryDeadline, now, env,
    })
    if (completion.status === 'authoritative_mismatch') {
      console.error('ARTIFACT_INTEGRITY_INCIDENT', {
        reason: completion.reason, finalizationId: finalization.id,
      })
      return {
        status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE,
        protectedFinalizedHistory: operation.status === 'finalized' || undefined,
      }
    }
    if (completion.status !== 'completed') {
      return { status: 'in_progress', retryAfterSeconds: 1 }
    }
    finalization = { ...finalization, status: 'finalized' }
  } else if (finalization.status === 'failed') {
    // Repair only a proof-backed historical split. Parent-first ordering makes
    // any acknowledgement loss converge toward finalized and protects children.
    const repaired = await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET status = 'finalized', error_code = NULL, lease_owner = NULL,
           lease_expires_at = NULL, recovery_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'failed'`,
    ).bind(now, job.tenantId, finalization.id).run().catch(() => null)
    if (!repaired || Number(repaired.meta.changes ?? 0) !== 1) {
      return { status: 'in_progress', retryAfterSeconds: 1 }
    }
    finalization = { ...finalization, status: 'finalized' }
  }

  if (operation.status !== 'finalized') {
    try {
      await markArtifactOperationsFinalizedForCompletedFinalization({
        tenantId: job.tenantId, finalizationId: finalization.id,
        uploadIds: [operation.upload_id],
        captureId: finalization.canonical_capture_id,
        documentId: finalization.canonical_document_id,
        operationId: finalization.canonical_operation_id, now: Date.now(),
      }, env)
    } catch {
      return { status: 'in_progress', retryAfterSeconds: 1 }
    }
  }

  try {
    await repairChannelMediaFinalized({
      tenantId: job.tenantId, operationId: job.id, uploadId: operation.upload_id,
      captureId: finalization.canonical_capture_id,
      documentId: finalization.canonical_document_id,
      canonicalOperationId: finalization.canonical_operation_id,
    }, env)
  } catch {
    return { status: 'in_progress', retryAfterSeconds: 1 }
  }
  return { status: 'recovered' }
}
