import type { CanonicalMemoryStore } from '../canonical-postgres-repository'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import type { ImmutableRolloutSnapshotRow } from './immutable-rollout-digest'

export async function proveCanonicalArtifactPromotion(
  store: CanonicalMemoryStore,
  row: ImmutableRolloutSnapshotRow,
  targetR2Key: string,
): Promise<void> {
  const document = await store.getDocument(row.tenant_id, row.canonical_document_id)
  const artifact = document?.artifact_manifest.find(item => item.artifact_id === row.artifact_id)
  if (!artifact || artifact.storage_kind !== 'managed_r2' || artifact.r2_key !== targetR2Key ||
    artifact.byte_length !== row.byte_length ||
    artifact.sha256 !== row.plaintext_sha256 || artifact.cipher_sha256 !== row.ciphertext_sha256 ||
    artifact.encryption_family !== row.encryption_family) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
}
