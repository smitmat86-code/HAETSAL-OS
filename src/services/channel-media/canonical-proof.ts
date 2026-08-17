import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import type { ArtifactFinalizationRow } from '../artifact-intake/finalize'
import type { ArtifactIntakeOperationRow } from '../artifact-intake/operations'
import { proveArtifactFinalizationCanonicalSuccess } from '../artifact-intake/finalization-proof'
import {
  artifactProofIndeterminate, artifactProofMismatch, type ArtifactProofResult, verifiedArtifactProof,
} from '../artifact-intake/proof-result'
import { getCanonicalMemoryStore } from '../canonical-postgres'

export async function proveChannelCanonicalSuccess(args: {
  job: ChannelMediaJob
  finalization: ArtifactFinalizationRow
  operation: ArtifactIntakeOperationRow
  env: Env
}): Promise<ArtifactProofResult> {
  const { job, finalization, operation, env } = args
  if (
    Number(finalization.expected_operation_count) !== 1 ||
    operation.finalization_id !== finalization.id || operation.expiry_claim_token ||
    !['sealed', 'finalized'].includes(operation.status) ||
    operation.canonical_capture_id !== finalization.canonical_capture_id ||
    operation.canonical_document_id !== finalization.canonical_document_id ||
    operation.canonical_operation_id !== finalization.canonical_operation_id ||
    operation.encryption_family !== 'tmk' || !operation.ciphertext_sha256 ||
    !operation.ciphertext_byte_length
  ) return artifactProofMismatch('operation_metadata_mismatch')

  const artifactProof = await proveArtifactFinalizationCanonicalSuccess({
    finalization, operations: [operation], env,
  })
  if (artifactProof.status !== 'verified') return artifactProof

  const store = getCanonicalMemoryStore(env)
  let capture
  let document
  let canonicalOperation
  try {
    capture = await store.getCapture(job.tenantId, finalization.canonical_capture_id)
    document = await store.getDocument(job.tenantId, finalization.canonical_document_id)
    canonicalOperation = await store.getOperationById(job.tenantId, finalization.canonical_operation_id)
  } catch {
    return artifactProofIndeterminate('canonical_store_unavailable')
  }
  if (!capture || !document || !canonicalOperation) {
    return artifactProofMismatch('canonical_record_missing')
  }
  const manifest = document.artifact_manifest ?? []
  const primary = manifest.filter(item => item.primary)
  const source = manifest.filter(item => item.role === 'source')
  const artifact = manifest[0]
  return artifact &&
    capture.source_system === job.provider &&
    capture.source_ref === `${job.provider}:operation:${job.id}` &&
    capture.artifact_id === operation.artifact_id &&
    document.capture_id === capture.id && document.artifact_id === operation.artifact_id &&
    document.body_r2_key === capture.body_r2_key &&
    canonicalOperation.capture_id === capture.id && canonicalOperation.status === 'accepted' &&
    manifest.length === 1 && source.length === 1 && primary.length === 1 &&
    artifact.artifact_id === operation.artifact_id && artifact.role === 'source' &&
    artifact.parent_artifact_id === null && artifact.primary &&
    artifact.storage_kind === 'managed_r2' && artifact.r2_key === operation.r2_key &&
    Number(artifact.byte_length) === Number(operation.byte_length) &&
    artifact.sha256 === operation.plaintext_sha256 &&
    artifact.cipher_sha256 === operation.ciphertext_sha256 &&
    artifact.encryption_family === operation.encryption_family
    ? verifiedArtifactProof(undefined)
    : artifactProofMismatch('canonical_metadata_mismatch')
}
