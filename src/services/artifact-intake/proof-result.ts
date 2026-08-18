export type ArtifactProofMismatchReason =
  | 'object_missing'
  | 'storage_key_mismatch'
  | 'ciphertext_byte_length_mismatch'
  | 'ciphertext_hash_mismatch'
  | 'operation_metadata_mismatch'
  | 'operation_set_mismatch'
  | 'canonical_record_missing'
  | 'canonical_metadata_mismatch'
  | 'canonical_manifest_mismatch'

export type ArtifactProofUnavailableReason =
  | 'r2_unavailable'
  | 'd1_unavailable'
  | 'canonical_store_unavailable'
  | 'crypto_unavailable'

export type ArtifactProofResult<T = undefined> =
  | { status: 'verified'; value: T }
  | { status: 'authoritative_mismatch'; reason: ArtifactProofMismatchReason }
  | { status: 'indeterminate'; reason: ArtifactProofUnavailableReason }

export function verifiedArtifactProof<T>(value: T): ArtifactProofResult<T> {
  return { status: 'verified', value }
}

export function artifactProofMismatch(
  reason: ArtifactProofMismatchReason,
): { status: 'authoritative_mismatch'; reason: ArtifactProofMismatchReason } {
  return { status: 'authoritative_mismatch', reason }
}

export function artifactProofIndeterminate(
  reason: ArtifactProofUnavailableReason,
): { status: 'indeterminate'; reason: ArtifactProofUnavailableReason } {
  return { status: 'indeterminate', reason }
}
