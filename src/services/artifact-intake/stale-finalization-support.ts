import type { Env } from '../../types/env'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import type { ArtifactFinalizationRow } from './finalize'
import {
  artifactProofIndeterminate, artifactProofMismatch, type ArtifactProofResult,
} from './proof-result'
import {
  loadArtifactOperationsForFinalization,
  type ArtifactIntakeOperationRow,
} from './operations'

export interface StaleArtifactFinalizationRecoveryResult {
  failed: number
  repairedFinalized: number
  deferred: number
  integrityIncidents: number
}

export async function loadProofOperations(
  finalization: ArtifactFinalizationRow,
  env: Env,
): Promise<{ operations: ArtifactIntakeOperationRow[]; proof?: never } | { proof: ArtifactProofResult; operations?: never }> {
  try {
    return {
      operations: await loadArtifactOperationsForFinalization({
        tenantId: finalization.tenant_id, finalizationId: finalization.id,
        expectedOperationCount: Number(finalization.expected_operation_count),
      }, env),
    }
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError) {
      // Bounds violations are malformed persisted state: protected for
      // manual review, never classified as deletion-eligible corruption.
      return {
        proof: error.code === ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED
          ? artifactProofIndeterminate('bounds_exceeded')
          : artifactProofMismatch('operation_set_mismatch'),
      }
    }
    return { proof: artifactProofIndeterminate('d1_unavailable') }
  }
}

export function deferOrProtect(
  proof: { status: 'indeterminate'; reason: string },
  finalizationId: string,
  result: StaleArtifactFinalizationRecoveryResult,
): void {
  if (proof.reason === 'bounds_exceeded') {
    console.error('ARTIFACT_INTEGRITY_INCIDENT', { reason: 'bounds_exceeded', finalizationId })
    result.integrityIncidents += 1
    return
  }
  result.deferred += 1
}
