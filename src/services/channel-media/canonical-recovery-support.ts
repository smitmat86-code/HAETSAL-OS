import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sha256Text } from '../artifact-intake/crypto'
import type { ArtifactFinalizationRow } from '../artifact-intake/finalize'
import {
  acquireArtifactFinalizationLease,
  failArtifactFinalizationAndReleaseOperations,
  markArtifactOperationsFinalized,
  type ArtifactIntakeOperationRow,
} from '../artifact-intake/operations'
import { artifactProofIndeterminate, type ArtifactProofResult } from '../artifact-intake/proof-result'
import { proveChannelCanonicalSuccess } from './canonical-proof'

export type ChannelMediaCanonicalRecoveryResult =
  | { status: 'recovered' } | { status: 'in_progress'; retryAfterSeconds: number }
  | { status: 'stably_absent' }
  | { status: 'failed'; errorCode: string }
  | { status: 'inconsistent'; errorCode: string; protectedFinalizedHistory?: boolean }

export async function finalizationFor(
  job: ChannelMediaJob,
  env: Env,
): Promise<ArtifactFinalizationRow | null> {
  return env.D1_US.prepare(
    `SELECT * FROM artifact_intake_finalizations
     WHERE tenant_id = ? AND idempotency_hash = ? LIMIT 1`,
  ).bind(job.tenantId, await sha256Text(`channel-media-finalize:${job.id}`))
    .first<ArtifactFinalizationRow>()
}

export async function failStaleFinalization(
  finalization: ArtifactFinalizationRow,
  env: Env,
  now: number,
): Promise<ChannelMediaCanonicalRecoveryResult> {
  const failed = await failArtifactFinalizationAndReleaseOperations({
    tenantId: finalization.tenant_id, finalizationId: finalization.id,
    errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED, now,
  }, env).catch(() => false)
  return failed
    ? { status: 'failed', errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED }
    : { status: 'in_progress', retryAfterSeconds: 1 }
}

export async function loadChannelFinalizationOperations(
  job: ChannelMediaJob,
  finalization: ArtifactFinalizationRow,
  env: Env,
): Promise<ArtifactIntakeOperationRow[] | null> {
  try {
    const loaded = await env.D1_US.prepare(
      `SELECT * FROM artifact_intake_operations
       WHERE tenant_id = ? AND finalization_id = ? ORDER BY upload_id ASC`,
    ).bind(job.tenantId, finalization.id).all<ArtifactIntakeOperationRow>()
    return loaded.results
  } catch {
    return null
  }
}

export async function completeReservedFinalization(args: {
  job: ChannelMediaJob
  finalization: ArtifactFinalizationRow
  operation: ArtifactIntakeOperationRow
  recoveryDeadline: number
  now: number
  env: Env
}): Promise<
  | { status: 'completed' }
  | { status: 'lease_unavailable' }
  | Exclude<ArtifactProofResult, { status: 'verified' }>
> {
  const leaseOwner = crypto.randomUUID()
  try {
    await acquireArtifactFinalizationLease({
      tenantId: args.job.tenantId, finalizationId: args.finalization.id, leaseOwner,
      expectedOperationCount: 1,
      captureId: args.finalization.canonical_capture_id,
      documentId: args.finalization.canonical_document_id,
      operationId: args.finalization.canonical_operation_id,
      now: args.now, allowExpiredRecoveryProof: args.recoveryDeadline <= args.now,
    }, args.env)
    const repeated = await proveChannelCanonicalSuccess({
      job: args.job, finalization: args.finalization, operation: args.operation, env: args.env,
    })
    if (repeated.status !== 'verified') return repeated
    const completionNow = Date.now()
    await markArtifactOperationsFinalized({
      tenantId: args.job.tenantId, finalizationId: args.finalization.id, leaseOwner,
      uploadIds: [args.operation.upload_id], captureId: args.finalization.canonical_capture_id,
      documentId: args.finalization.canonical_document_id,
      operationId: args.finalization.canonical_operation_id, now: completionNow,
    }, args.env)
    const completed = await args.env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET status = 'finalized', error_code = NULL, lease_owner = NULL,
           lease_expires_at = NULL, recovery_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved'
         AND lease_owner = ? AND lease_expires_at > ?`,
    ).bind(completionNow, args.job.tenantId, args.finalization.id, leaseOwner, completionNow).run()
    if (Number(completed.meta.changes ?? 0) === 1) return { status: 'completed' }
    const reread = await finalizationFor(args.job, args.env)
    return reread?.status === 'finalized'
      ? { status: 'completed' }
      : artifactProofIndeterminate('d1_unavailable')
  } catch (error) {
    return error instanceof ArtifactIntakeContractError
      ? { status: 'lease_unavailable' }
      : artifactProofIndeterminate('d1_unavailable')
  }
}
