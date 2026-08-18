import type { Env } from '../../types/env'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import type { ArtifactFinalizationRow } from './finalize'
import type { ArtifactIntakeOperationRow } from './operations'
import { proveManagedArtifactCiphertext } from './storage'
import { artifactManifestIdentitySha256 } from './manifest-identity'
import {
  artifactProofIndeterminate,
  artifactProofMismatch,
  type ArtifactProofResult,
  verifiedArtifactProof,
} from './proof-result'

/** Proves the complete cross-store boundary without relying on caller input. */
export async function proveArtifactFinalizationCanonicalSuccess(args: {
  finalization: ArtifactFinalizationRow
  operations: ArtifactIntakeOperationRow[]
  env: Env
}): Promise<ArtifactProofResult> {
  const { finalization, operations, env } = args
  if (
    Number(finalization.expected_operation_count) <= 0 ||
    !finalization.artifact_manifest_sha256 ||
    operations.length !== Number(finalization.expected_operation_count) ||
    new Set(operations.map(row => row.upload_id)).size !== operations.length ||
    new Set(operations.map(row => row.artifact_id)).size !== operations.length
  ) return artifactProofMismatch('operation_set_mismatch')

  // Sequential proof bounds live ciphertext memory to one object. Never replace
  // this with unbounded Promise.all over manifest entries.
  for (const row of operations) {
    if (
      !['sealed', 'finalized'].includes(row.status) || row.finalization_id !== finalization.id ||
      row.expiry_claim_token || row.canonical_capture_id !== finalization.canonical_capture_id ||
      row.canonical_document_id !== finalization.canonical_document_id ||
      row.canonical_operation_id !== finalization.canonical_operation_id ||
      !row.ciphertext_sha256 || !row.ciphertext_byte_length || !row.encryption_family
    ) return artifactProofMismatch('operation_metadata_mismatch')
    const rawProof = await proveManagedArtifactCiphertext({
      env, tenantId: row.tenant_id, uploadId: row.upload_id, recordedKey: row.r2_key,
      adoptedAttemptToken: row.adopted_attempt_token,
      expectedCiphertextByteLength: Number(row.ciphertext_byte_length),
      expectedCiphertextSha256: row.ciphertext_sha256,
    })
    if (rawProof.status !== 'verified') return rawProof
  }

  const store = getCanonicalMemoryStore(env)
  let capture
  let document
  let operation
  try {
    // An exception is indeterminate; an authoritative null row is a mismatch.
    capture = await store.getCapture(finalization.tenant_id, finalization.canonical_capture_id)
    document = await store.getDocument(finalization.tenant_id, finalization.canonical_document_id)
    operation = await store.getOperationById(finalization.tenant_id, finalization.canonical_operation_id)
  } catch {
    return artifactProofIndeterminate('canonical_store_unavailable')
  }
  if (!capture || !document || !operation) return artifactProofMismatch('canonical_record_missing')

  const manifest = document.artifact_manifest ?? []
  const primary = manifest.filter(item => item.primary)
  const manifestIds = new Set(manifest.map(item => item.artifact_id))
  const source = manifest.filter(item => item.role === 'source')
  if (
    manifest.length !== operations.length || manifestIds.size !== manifest.length ||
    source.length !== 1 || primary.length !== 1 || primary[0]!.role !== 'source' ||
    primary[0]!.parent_artifact_id !== null || capture.artifact_id !== primary[0]!.artifact_id ||
    document.capture_id !== capture.id || document.artifact_id !== primary[0]!.artifact_id ||
    document.body_r2_key !== capture.body_r2_key || operation.capture_id !== capture.id ||
    operation.status !== 'accepted'
  ) return artifactProofMismatch('canonical_metadata_mismatch')

  const byArtifact = new Map(operations.map(row => [row.artifact_id, row]))
  const priorArtifacts = new Set<string>()
  const exactManifest = manifest.every((artifact, ordinal) => {
    const row = byArtifact.get(artifact.artifact_id)
    const validParent = artifact.role === 'source'
      ? artifact.parent_artifact_id === null
      : artifact.parent_artifact_id !== null && priorArtifacts.has(artifact.parent_artifact_id)
    priorArtifacts.add(artifact.artifact_id)
    return Boolean(validParent && artifact.media_type &&
      row && artifact.ordinal === ordinal && artifact.storage_kind === 'managed_r2' &&
      artifact.r2_key === row.r2_key && Number(artifact.byte_length) === Number(row.byte_length) &&
      artifact.sha256 === row.plaintext_sha256 && artifact.cipher_sha256 === row.ciphertext_sha256 &&
      artifact.encryption_family === row.encryption_family)
  })
  if (!exactManifest) return artifactProofMismatch('canonical_manifest_mismatch')

  const canonicalIdentity = manifest.map(artifact => ({
    uploadId: byArtifact.get(artifact.artifact_id)!.upload_id,
    role: artifact.role,
    parentUploadId: artifact.parent_artifact_id
      ? byArtifact.get(artifact.parent_artifact_id)!.upload_id : null,
    primary: artifact.primary,
    mediaType: artifact.media_type!,
    byteLength: Number(artifact.byte_length),
    plaintextSha256: artifact.sha256!,
  }))
  try {
    return await artifactManifestIdentitySha256(canonicalIdentity) === finalization.artifact_manifest_sha256
      ? verifiedArtifactProof(undefined)
      : artifactProofMismatch('canonical_manifest_mismatch')
  } catch {
    return artifactProofIndeterminate('crypto_unavailable')
  }
}
