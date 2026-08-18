import type { Env } from '../../types/env'
import { ARTIFACT_MANIFEST_MAX_COUNT } from '../artifact-intake/config'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import type { ArtifactFinalizationRow } from '../artifact-intake/finalize'
import type { ArtifactIntakeOperationRow } from '../artifact-intake/operations'
import type { ArtifactProofMismatchReason } from '../artifact-intake/proof-result'
import { channelMediaRetrySeconds } from './claim-outcome'
import {
  failStaleFinalization, type ChannelMediaCanonicalRecoveryResult,
} from './canonical-recovery-support'

function protectedIncident(
  reason: string,
  finalizationId: string,
): ChannelMediaCanonicalRecoveryResult {
  console.error('ARTIFACT_INTEGRITY_INCIDENT', { reason, finalizationId })
  return {
    status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE,
    protectedFinalizedHistory: true,
  }
}

/**
 * Malformed persisted counts are protected for manual review; they must never
 * drive unbounded proof work or become deletion-eligible.
 */
export function boundsGuardOutcome(
  finalization: ArtifactFinalizationRow,
): ChannelMediaCanonicalRecoveryResult | null {
  const expectedOperationCount = Number(finalization.expected_operation_count)
  if (!Number.isInteger(expectedOperationCount) ||
      expectedOperationCount > ARTIFACT_MANIFEST_MAX_COUNT) {
    return protectedIncident('bounds_exceeded', finalization.id)
  }
  return null
}

export async function operationSetMismatchOutcome(args: {
  finalization: ArtifactFinalizationRow
  operations: ArtifactIntakeOperationRow[]
  recoveryDeadline: number
  now: number
  env: Env
}): Promise<ChannelMediaCanonicalRecoveryResult> {
  const { finalization, operations, recoveryDeadline, now, env } = args
  if (finalization.status === 'finalized' || operations.some(row => row.status === 'finalized')) {
    return protectedIncident('operation_set_mismatch', finalization.id)
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

export async function authoritativeMismatchOutcome(args: {
  finalization: ArtifactFinalizationRow
  operation: ArtifactIntakeOperationRow
  reason: ArtifactProofMismatchReason
  recoveryDeadline: number
  now: number
  env: Env
}): Promise<ChannelMediaCanonicalRecoveryResult> {
  const { finalization, operation, reason, recoveryDeadline, now, env } = args
  if (finalization.status === 'finalized' || operation.status === 'finalized') {
    return protectedIncident(reason, finalization.id)
  }
  if (finalization.status === 'failed') return {
    status: 'failed',
    errorCode: finalization.error_code ?? ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED,
  }
  if (reason === 'canonical_record_missing') {
    // Inside the recovery window the reservation can still acquire a normal
    // lease, so absence is retryable: data is preserved and the normal
    // finalize path repairs it. Once the deadline expires, only the guarded
    // failure below may run — its CAS requires no live lease — so the
    // reservation never stays permanently bound and raw data is never
    // released beneath a live canonical writer.
    return recoveryDeadline > now
      ? { status: 'stably_absent' }
      : failStaleFinalization(finalization, env, now)
  }
  return recoveryDeadline <= now
    ? failStaleFinalization(finalization, env, now)
    : { status: 'in_progress', retryAfterSeconds: channelMediaRetrySeconds(recoveryDeadline, now) }
}
