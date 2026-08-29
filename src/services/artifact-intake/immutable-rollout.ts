import type { Env } from '../../types/env'
import { fetchAndValidateKek } from '../../cron/kek'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Bytes, sha256Text, unsealArtifactBytes } from './crypto'
import {
  IMMUTABLE_ROLLOUT_CATEGORY,
  immutableRolloutDigest,
  immutableRolloutManifest,
  type ImmutableRolloutSnapshotRow,
} from './immutable-rollout-digest'
import { managedArtifactAttemptR2Key } from './storage-keys'
import { putManagedArtifactCiphertext, readManagedArtifactCiphertext } from './storage'
import { ARTIFACT_UPLOAD_PROTOCOL_FENCED } from './upload-protocol'
import { proveCanonicalArtifactPromotion } from './immutable-rollout-canonical-proof'
interface CurrentOperation {
  status: string
  r2_key: string
  adopted_attempt_token: string | null
  ciphertext_sha256: string | null
  ciphertext_byte_length: number | null
  upload_protocol: string | null
  immutable_finalize_authorized: number
}
export interface ImmutableRolloutFence {
  afterCanonicalPromotion?: (row: ImmutableRolloutSnapshotRow) => Promise<void>
}
async function snapshotRows(env: Env, tenantId: string): Promise<ImmutableRolloutSnapshotRow[]> {
  const result = await env.D1_US.prepare(
    `SELECT * FROM artifact_immutable_rollout_repairs
     WHERE tenant_id = ? ORDER BY operation_id`,
  ).bind(tenantId).all<ImmutableRolloutSnapshotRow>()
  return result.results
}
function deterministicAttemptToken(digest: string, operationId: string): Promise<string> {
  return sha256Text(`immutable-rollout:${digest}:${operationId}`).then(hex =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`)
}
async function contentKey(row: ImmutableRolloutSnapshotRow, tmk: CryptoKey, env: Env): Promise<CryptoKey> {
  if (row.encryption_family === 'tmk') return tmk
  const kek = await fetchAndValidateKek(row.tenant_id, env)
  if (!kek) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  return kek
}
async function proveEnvelope(
  row: ImmutableRolloutSnapshotRow, key: CryptoKey, storageKey: string, env: Env,
): Promise<Uint8Array> {
  const envelope = await readManagedArtifactCiphertext(env, storageKey, row.ciphertext_byte_length)
  if (!envelope || await sha256Bytes(envelope) !== row.ciphertext_sha256) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
  }
  const plaintext = await unsealArtifactBytes(envelope, key, row.encryption_family)
  if (plaintext.byteLength !== row.byte_length || await sha256Bytes(plaintext) !== row.plaintext_sha256) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
  }
  return envelope
}
async function currentOperation(row: ImmutableRolloutSnapshotRow, env: Env): Promise<CurrentOperation | null> {
  return env.D1_US.prepare(
    `SELECT status, r2_key, adopted_attempt_token, ciphertext_sha256, ciphertext_byte_length,
            upload_protocol, immutable_finalize_authorized
     FROM artifact_intake_operations WHERE tenant_id = ? AND upload_id = ? AND id = ?`,
  ).bind(row.tenant_id, row.upload_id, row.operation_id).first<CurrentOperation>()
}

async function repairOne(
  row: ImmutableRolloutSnapshotRow, digest: string, tmk: CryptoKey, env: Env, fence: ImmutableRolloutFence,
): Promise<void> {
  const token = await deterministicAttemptToken(digest, row.operation_id)
  const targetKey = await managedArtifactAttemptR2Key(row.tenant_id, row.upload_id, token)
  const current = await currentOperation(row, env)
  if (!current || current.status !== 'finalized') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const key = await contentKey(row, tmk, env)
  if (current.adopted_attempt_token === null) {
    if (current.r2_key !== row.original_r2_key || current.ciphertext_sha256 !== row.ciphertext_sha256 ||
      current.ciphertext_byte_length !== row.ciphertext_byte_length) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    const envelope = await proveEnvelope(row, key, row.original_r2_key, env)
    await putManagedArtifactCiphertext(env, targetKey, envelope)
  } else if (current.adopted_attempt_token !== token || current.r2_key !== targetKey) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  await proveEnvelope(row, key, targetKey, env)
  const canonicalStore = getCanonicalMemoryStore(env)
  const canonical = await canonicalStore.promoteArtifactStorageIdentity({
    tenantId: row.tenant_id, captureId: row.canonical_capture_id, artifactId: row.artifact_id,
    originalR2Key: row.original_r2_key, targetR2Key: targetKey,
    plaintextSha256: row.plaintext_sha256, ciphertextSha256: row.ciphertext_sha256,
    byteLength: row.byte_length, encryptionFamily: row.encryption_family,
  })
  if (canonical === 'mismatch') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  await fence.afterCanonicalPromotion?.(row)
  await env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET r2_key = ?, adopted_attempt_token = ?, upload_protocol = ?,
         immutable_finalize_authorized = 1, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND id = ? AND status = 'finalized'
       AND r2_key = ? AND adopted_attempt_token IS NULL
       AND ciphertext_sha256 = ? AND ciphertext_byte_length = ?`,
  ).bind(targetKey, token, ARTIFACT_UPLOAD_PROTOCOL_FENCED, Date.now(), row.tenant_id,
    row.upload_id, row.operation_id, row.original_r2_key, row.ciphertext_sha256,
    row.ciphertext_byte_length).run()
  const repaired = await currentOperation(row, env)
  if (!repaired || repaired.r2_key !== targetKey || repaired.adopted_attempt_token !== token ||
    repaired.upload_protocol !== ARTIFACT_UPLOAD_PROTOCOL_FENCED ||
    repaired.immutable_finalize_authorized !== 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  await proveCanonicalArtifactPromotion(canonicalStore, row, targetKey)
  await env.D1_US.prepare(
    `UPDATE artifact_immutable_rollout_repairs
     SET repair_state = 'completed', approval_digest = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ?`,
  ).bind(digest, Date.now(), row.tenant_id, row.upload_id).run()
}

export async function immutableRolloutStatus(tenantId: string, env: Env) {
  const rows = await snapshotRows(env, tenantId)
  const manifest = await immutableRolloutManifest(rows)
  const digest = await immutableRolloutDigest(rows)
  return {
    ...manifest, entries: undefined,
    exact_target_digest: digest,
    pending_count: rows.filter(row => row.repair_state === 'pending').length,
    completed_count: rows.filter(row => row.repair_state === 'completed').length,
    approved_count: rows.filter(row => row.approval_digest === digest).length,
  }
}

export async function repairImmutableArtifactRollout(args: {
  tenantId: string
  category: typeof IMMUTABLE_ROLLOUT_CATEGORY
  expectedTargetCount: number
  approvalDigest: string
  tmk: CryptoKey
}, env: Env, fence: ImmutableRolloutFence = {}) {
  const rows = await snapshotRows(env, args.tenantId)
  const digest = await immutableRolloutDigest(rows)
  if (args.category !== IMMUTABLE_ROLLOUT_CATEGORY || rows.length !== args.expectedTargetCount ||
    digest !== args.approvalDigest ||
    rows.some(row => row.approval_digest !== digest)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  for (const row of rows) await repairOne(row, digest, args.tmk, env, fence)
  return immutableRolloutStatus(args.tenantId, env)
}
