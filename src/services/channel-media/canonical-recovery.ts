import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sha256Text } from '../artifact-intake/crypto'
import type { ArtifactFinalizationRow } from '../artifact-intake/finalize'
import {
  acquireArtifactFinalizationLease, failArtifactFinalizationAndReleaseOperations,
  loadArtifactOperationsForFinalization, markArtifactOperationsFinalized,
  type ArtifactIntakeOperationRow,
} from '../artifact-intake/operations'
import { ARTIFACT_FINALIZATION_RECOVERY_MS } from '../artifact-intake/config'
import { channelMediaRetrySeconds } from './claim-outcome'
import { invalidateRawArtifactProof, proveChannelCanonicalSuccess } from './canonical-proof'
import { repairChannelMediaFinalized } from './job-transitions'
export type ChannelMediaCanonicalRecoveryResult =
  | { status: 'recovered' } | { status: 'in_progress'; retryAfterSeconds: number }
  | { status: 'stably_absent' }
  | { status: 'failed'; errorCode: string }
  | { status: 'inconsistent'; errorCode: string }
async function finalizationFor(job: ChannelMediaJob, env: Env): Promise<ArtifactFinalizationRow | null> {
  return env.D1_US.prepare(
    `SELECT * FROM artifact_intake_finalizations
     WHERE tenant_id = ? AND idempotency_hash = ? LIMIT 1`,
  ).bind(job.tenantId, await sha256Text(`channel-media-finalize:${job.id}`))
    .first<ArtifactFinalizationRow>()
}
async function failStaleFinalization(
  finalization: ArtifactFinalizationRow,
  env: Env,
  now: number,
): Promise<ChannelMediaCanonicalRecoveryResult> {
  const failed = await failArtifactFinalizationAndReleaseOperations({
    tenantId: finalization.tenant_id,
    finalizationId: finalization.id,
    errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED,
    now,
  }, env)
  return failed
    ? { status: 'failed', errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED }
    : { status: 'in_progress', retryAfterSeconds: 1 }
}
/** Repair D1/channel success only after exact canonical and managed-R2 proof. */
export async function recoverFinalizedChannelMediaJob(
  job: ChannelMediaJob,
  env: Env,
): Promise<ChannelMediaCanonicalRecoveryResult> {
  const finalization = await finalizationFor(job, env)
  if (!finalization) return { status: 'stably_absent' }
  if (finalization.status === 'failed') {
    return {
      status: 'failed',
      errorCode: finalization.error_code ?? ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED,
    }
  }
  const store = getCanonicalMemoryStore(env)
  const capture = await store.getCapture(job.tenantId, finalization.canonical_capture_id)
  const now = Date.now()
  const recoveryDeadline = finalization.recovery_expires_at === null
    ? Number(finalization.updated_at) + ARTIFACT_FINALIZATION_RECOVERY_MS
    : Number(finalization.recovery_expires_at)
  if (!capture) {
    if (finalization.status === 'finalized') {
      return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
    }
    if (recoveryDeadline <= now) {
      return failStaleFinalization(finalization, env, now)
    }
    if (finalization.lease_expires_at !== null && Number(finalization.lease_expires_at) > now) {
      return {
        status: 'in_progress',
        retryAfterSeconds: channelMediaRetrySeconds(Number(finalization.lease_expires_at), now),
      }
    }
    return { status: 'stably_absent' }
  }
  if (
    finalization.status === 'reserved' && finalization.lease_expires_at !== null &&
    Number(finalization.lease_expires_at) > now
  ) {
    return {
      status: 'in_progress',
      retryAfterSeconds: channelMediaRetrySeconds(Number(finalization.lease_expires_at), now),
    }
  }
  let operations: ArtifactIntakeOperationRow[]
  try {
    operations = await loadArtifactOperationsForFinalization({
      tenantId: job.tenantId, finalizationId: finalization.id,
      expectedOperationCount: Number(finalization.expected_operation_count),
    }, env)
  } catch {
    return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
  }
  const operation = operations[0]
  if (!operation || operations.length !== 1 ||
      !await proveChannelCanonicalSuccess({ job, finalization, operation, env })) {
    await invalidateRawArtifactProof(finalization, env, now)
    return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
  }
  if (finalization.status === 'reserved') {
    const leaseOwner = crypto.randomUUID()
    try {
      await acquireArtifactFinalizationLease({
        tenantId: job.tenantId, finalizationId: finalization.id, leaseOwner,
        expectedOperationCount: 1,
        captureId: finalization.canonical_capture_id,
        documentId: finalization.canonical_document_id,
        operationId: finalization.canonical_operation_id,
        now,
        allowExpiredRecoveryProof: recoveryDeadline <= now,
      }, env)
      if (!await proveChannelCanonicalSuccess({ job, finalization, operation, env })) {
        await invalidateRawArtifactProof(finalization, env, Date.now())
        return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
      }
      const completionNow = Date.now()
      await markArtifactOperationsFinalized({
        tenantId: job.tenantId, finalizationId: finalization.id, leaseOwner,
        uploadIds: [operation.upload_id],
        captureId: finalization.canonical_capture_id,
        documentId: finalization.canonical_document_id,
        operationId: finalization.canonical_operation_id,
        now: completionNow,
      }, env)
      const completed = await env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations
         SET status = 'finalized', error_code = NULL, lease_owner = NULL,
             lease_expires_at = NULL, recovery_expires_at = NULL, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'reserved'
           AND lease_owner = ? AND lease_expires_at > ?`,
      ).bind(completionNow, job.tenantId, finalization.id, leaseOwner, completionNow).run()
      if (Number(completed.meta.changes ?? 0) !== 1) {
        throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
      }
    } catch {
      return { status: 'in_progress', retryAfterSeconds: 1 }
    }
  } else if (operation.status !== 'finalized') {
    return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
  }
  await repairChannelMediaFinalized({
    tenantId: job.tenantId, operationId: job.id, uploadId: operation.upload_id,
    captureId: finalization.canonical_capture_id,
    documentId: finalization.canonical_document_id,
    canonicalOperationId: finalization.canonical_operation_id,
  }, env)
  return { status: 'recovered' }
}
