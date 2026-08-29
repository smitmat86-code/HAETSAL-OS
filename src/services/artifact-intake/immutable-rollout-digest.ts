import { sha256Text } from './crypto'

export const IMMUTABLE_ROLLOUT_CATEGORY = 'immutable_managed_finalized_v1' as const

export interface ImmutableRolloutSnapshotRow {
  tenant_id: string
  upload_id: string
  operation_id: string
  artifact_id: string
  original_r2_key: string
  byte_length: number
  plaintext_sha256: string
  ciphertext_sha256: string
  ciphertext_byte_length: number
  encryption_family: 'tmk' | 'kek'
  canonical_capture_id: string
  canonical_document_id: string
  canonical_operation_id: string
  finalization_id: string
  repair_state: 'pending' | 'completed'
  approval_digest: string | null
}

function exactTargetInput(row: ImmutableRolloutSnapshotRow): string {
  return [
    row.operation_id,
    row.tenant_id,
    row.upload_id,
    row.artifact_id,
    row.original_r2_key,
    row.byte_length,
    row.plaintext_sha256,
    row.ciphertext_sha256,
    row.ciphertext_byte_length,
    row.encryption_family,
    row.canonical_capture_id,
    row.canonical_document_id,
    row.canonical_operation_id,
    row.finalization_id,
  ].join('\0')
}

export async function immutableRolloutManifest(rows: ImmutableRolloutSnapshotRow[]) {
  const entries = await Promise.all(rows.map(async row => ({
    target_hash: await sha256Text(exactTargetInput(row)),
    byte_length: Number(row.byte_length),
    ciphertext_byte_length: Number(row.ciphertext_byte_length),
    encryption_family: row.encryption_family,
  })))
  entries.sort((left, right) => left.target_hash.localeCompare(right.target_hash))
  return {
    category: IMMUTABLE_ROLLOUT_CATEGORY,
    target_count: entries.length,
    plaintext_bytes: entries.reduce((total, entry) => total + entry.byte_length, 0),
    ciphertext_bytes: entries.reduce((total, entry) => total + entry.ciphertext_byte_length, 0),
    entries,
  }
}

export async function immutableRolloutDigest(rows: ImmutableRolloutSnapshotRow[]): Promise<string> {
  return sha256Text(JSON.stringify(await immutableRolloutManifest(rows)))
}
