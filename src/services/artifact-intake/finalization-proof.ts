import type { Env } from '../../types/env'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import type { ArtifactFinalizationRow } from './finalize'
import type { ArtifactIntakeOperationRow } from './operations'
import { proveManagedArtifactCiphertext } from './storage'
import { artifactManifestIdentitySha256 } from './manifest-identity'

/** Proves the complete cross-store boundary without relying on caller input. */
export async function proveArtifactFinalizationCanonicalSuccess(args: {
  finalization: ArtifactFinalizationRow
  operations: ArtifactIntakeOperationRow[]
  env: Env
}): Promise<boolean> {
  const { finalization, operations, env } = args
  if (
    Number(finalization.expected_operation_count) <= 0 ||
    !finalization.artifact_manifest_sha256 ||
    operations.length !== Number(finalization.expected_operation_count) ||
    new Set(operations.map(row => row.upload_id)).size !== operations.length ||
    new Set(operations.map(row => row.artifact_id)).size !== operations.length
  ) return false

  for (const row of operations) {
    if (
      !['sealed', 'finalized'].includes(row.status) || row.finalization_id !== finalization.id ||
      row.expiry_claim_token || row.canonical_capture_id !== finalization.canonical_capture_id ||
      row.canonical_document_id !== finalization.canonical_document_id ||
      row.canonical_operation_id !== finalization.canonical_operation_id ||
      !row.ciphertext_sha256 || !row.ciphertext_byte_length || !row.encryption_family
    ) return false
    try {
      await proveManagedArtifactCiphertext({
        env, tenantId: row.tenant_id, uploadId: row.upload_id, recordedKey: row.r2_key,
        expectedCiphertextByteLength: Number(row.ciphertext_byte_length),
        expectedCiphertextSha256: row.ciphertext_sha256,
      })
    } catch {
      return false
    }
  }

  const store = getCanonicalMemoryStore(env)
  const [capture, document, operation] = await Promise.all([
    store.getCapture(finalization.tenant_id, finalization.canonical_capture_id),
    store.getDocument(finalization.tenant_id, finalization.canonical_document_id),
    store.getOperationById(finalization.tenant_id, finalization.canonical_operation_id),
  ])
  const manifest = document?.artifact_manifest ?? []
  const primary = manifest.filter(item => item.primary)
  const manifestIds = new Set(manifest.map(item => item.artifact_id))
  const source = manifest.filter(item => item.role === 'source')
  if (
    !capture || !document || !operation || manifest.length !== operations.length ||
    manifestIds.size !== manifest.length || source.length !== 1 || primary.length !== 1 ||
    primary[0]!.role !== 'source' || primary[0]!.parent_artifact_id !== null ||
    capture.artifact_id !== primary[0]!.artifact_id ||
    document.capture_id !== capture.id || document.artifact_id !== primary[0]!.artifact_id ||
    document.body_r2_key !== capture.body_r2_key || operation.capture_id !== capture.id ||
    operation.status !== 'accepted'
  ) return false

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
      artifact.encryption_family === row.encryption_family,
    )
  })
  if (!exactManifest) return false
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
  return await artifactManifestIdentitySha256(canonicalIdentity) === finalization.artifact_manifest_sha256
}
