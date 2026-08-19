import type { Env } from '../../types/env'
import type {
  ArtifactEncryptionFamily,
  ArtifactUploadReceipt,
  ArtifactUploadState,
} from '../../types/artifact-intake'
import {
  ARTIFACT_CIPHERTEXT_ENVELOPE_OVERHEAD_BYTES,
  ARTIFACT_FINALIZATION_LEASE_MS,
  ARTIFACT_FINALIZATION_RECOVERY_MS,
  ARTIFACT_MANIFEST_MAX_COUNT,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_UPLOAD_ATTEMPT_LEASE_MS,
  ARTIFACT_UPLOAD_EXPIRY_MS,
} from './config'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  resolveArtifactMimeType,
} from './contracts'
import { sealArtifactBytes, sha256Bytes, sha256Text, unsealArtifactBytes } from './crypto'
import {
  cleanupLosingUploadAttempt,
  clearUploadAttemptIntent,
  recordUploadAttemptIntent,
} from './attempt-orphans'
import {
  managedArtifactAttemptR2Key,
  managedArtifactExists,
  managedArtifactR2Key,
  proveManagedArtifactCiphertext,
  putManagedArtifactCiphertext,
  readManagedArtifactCiphertext,
} from './storage'
import { isFencedUploadProtocol, reservedUploadProtocol } from './upload-protocol'

export interface ArtifactIntakeOperationRow {
  id: string
  tenant_id: string
  upload_id: string
  idempotency_hash: string
  status: ArtifactUploadState
  error_code: string | null
  artifact_id: string
  r2_key: string
  declared_mime_category: string | null
  detected_mime_category: string | null
  byte_length: number
  plaintext_sha256: string
  ciphertext_sha256: string | null
  ciphertext_byte_length: number | null
  encryption_family: Exclude<ArtifactEncryptionFamily, 'legacy_unsealed'> | null
  finalization_id: string | null
  finalization_protected_until: number | null
  expiry_claim_token: string | null
  expiry_claim_expires_at: number | null
  upload_attempt_token: string | null
  upload_attempt_expires_at: number | null
  adopted_attempt_token: string | null
  upload_protocol: string | null
  canonical_capture_id: string | null
  canonical_document_id: string | null
  canonical_operation_id: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

function mimeCategory(value?: string | null): string | null {
  if (!value) return null
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const [family] = normalized.split('/', 1)
  if (!family) return null
  if (family === 'image' || family === 'audio' || family === 'video' || family === 'text') return family
  if (normalized === 'application/pdf') return 'document'
  return 'application'
}

function toReceipt(row: ArtifactIntakeOperationRow): ArtifactUploadReceipt {
  return {
    operationId: row.id,
    uploadId: row.upload_id,
    artifactId: row.artifact_id,
    status: row.status,
    byteLength: Number(row.byte_length),
    plaintextSha256: row.plaintext_sha256,
    ciphertextSha256: row.ciphertext_sha256,
    encryptionFamily: row.encryption_family,
    expiresAt: Number(row.expires_at),
    canonicalCaptureId: row.canonical_capture_id,
    canonicalDocumentId: row.canonical_document_id,
    canonicalOperationId: row.canonical_operation_id,
    errorCode: row.error_code,
  }
}

export async function getArtifactIntakeOperation(
  env: Env,
  tenantId: string,
  uploadId: string,
): Promise<ArtifactIntakeOperationRow | null> {
  return env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations WHERE tenant_id = ? AND upload_id = ? LIMIT 1`,
  ).bind(tenantId, uploadId).first<ArtifactIntakeOperationRow>()
}

function assertOperationMatches(row: ArtifactIntakeOperationRow, args: {
  byteLength: number
  plaintextSha256: string
  declaredMimeType?: string | null
}): void {
  if (
    Number(row.byte_length) !== args.byteLength ||
    row.plaintext_sha256 !== args.plaintextSha256.toLowerCase() ||
    row.declared_mime_category !== mimeCategory(args.declaredMimeType)
  ) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
}

export async function reserveArtifactUpload(args: {
  tenantId: string
  idempotencyKey: string
  byteLength: number
  plaintextSha256: string
  declaredMimeType?: string | null
  now?: number
}, env: Env): Promise<ArtifactUploadReceipt> {
  if (args.byteLength <= 0 || args.byteLength > ARTIFACT_MAX_BYTES) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
  }
  if (!/^[a-f0-9]{64}$/i.test(args.plaintextSha256) || args.idempotencyKey.length < 16 || args.idempotencyKey.length > 200) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  const now = args.now ?? Date.now()
  const idempotencyHash = await sha256Text(args.idempotencyKey)
  const uploadId = crypto.randomUUID()
  const operationId = crypto.randomUUID()
  const artifactId = crypto.randomUUID()
  const r2Key = await managedArtifactR2Key(args.tenantId, uploadId)
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO artifact_intake_operations
     (id, tenant_id, upload_id, idempotency_hash, status, error_code, artifact_id, r2_key,
      declared_mime_category, detected_mime_category, byte_length, plaintext_sha256,
      ciphertext_sha256, encryption_family, canonical_capture_id, canonical_document_id,
      canonical_operation_id, upload_protocol, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
  ).bind(
    operationId,
    args.tenantId,
    uploadId,
    idempotencyHash,
    artifactId,
    r2Key,
    mimeCategory(args.declaredMimeType),
    args.byteLength,
    args.plaintextSha256.toLowerCase(),
    reservedUploadProtocol(env),
    now,
    now,
    now + ARTIFACT_UPLOAD_EXPIRY_MS,
  ).run()
  const row = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations WHERE tenant_id = ? AND idempotency_hash = ? LIMIT 1`,
  ).bind(args.tenantId, idempotencyHash).first<ArtifactIntakeOperationRow>()
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  assertOperationMatches(row, args)
  return toReceipt(row)
}

export async function getArtifactIntakeStatus(args: {
  tenantId: string
  uploadId: string
}, env: Env): Promise<ArtifactUploadReceipt> {
  const row = await getArtifactIntakeOperation(env, args.tenantId, args.uploadId)
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.NOT_FOUND)
  return toReceipt(row)
}

/**
 * Attempt-fenced failure. Only the exact live attempt owner of an unexpired,
 * unclaimed, unbound reserved/failed operation may record failure. Exactly
 * one row must change; a stale writer is told it lost ownership and must not
 * report that it changed state.
 */
export async function markUploadFailed(
  env: Env,
  row: ArtifactIntakeOperationRow,
  attemptToken: string,
  errorCode: string,
): Promise<'failed_recorded' | 'ownership_lost'> {
  const now = Date.now()
  const result = await env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET status = 'failed', error_code = ?, upload_attempt_token = NULL,
         upload_attempt_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status IN ('reserved', 'failed')
       AND upload_attempt_token = ? AND upload_attempt_expires_at > ?
       AND expires_at > ?
       AND expiry_claim_token IS NULL AND finalization_id IS NULL`,
  ).bind(errorCode, now, row.tenant_id, row.upload_id, attemptToken, now, now).run()
  return changed(result) === 1 ? 'failed_recorded' : 'ownership_lost'
}

interface AdoptCiphertextArgs {
  row: ArtifactIntakeOperationRow
  env: Env
  attemptToken: string
  detectedMimeType: string
  family: 'tmk' | 'kek'
  ciphertextSha256: string
  ciphertextByteLength: number
  /** NULL adopts the legacy per-upload key already recorded in r2_key. */
  adoptedKey: string | null
}

/**
 * CAS adoption of exactly one attempt's ciphertext identity. The guards prove
 * live attempt ownership, an unexpired unfinalized operation, no expiry claim,
 * and no finalization binding; a stale or raced writer changes zero rows.
 */
async function adoptUploadedCiphertext(args: AdoptCiphertextArgs): Promise<boolean> {
  const now = Date.now()
  const result = await args.env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET status = 'sealed', error_code = NULL, detected_mime_category = ?, ciphertext_sha256 = ?,
         ciphertext_byte_length = ?, encryption_family = ?,
         r2_key = COALESCE(?, r2_key), adopted_attempt_token = ?,
         upload_attempt_token = NULL, upload_attempt_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status IN ('reserved', 'failed')
       AND upload_attempt_token = ? AND upload_attempt_expires_at > ?
       AND expiry_claim_token IS NULL AND finalization_id IS NULL AND expires_at > ?`,
  ).bind(
    mimeCategory(args.detectedMimeType), args.ciphertextSha256,
    args.ciphertextByteLength, args.family,
    args.adoptedKey, args.adoptedKey === null ? null : args.attemptToken,
    now, args.row.tenant_id, args.row.upload_id, args.attemptToken, now, now,
  ).run()
  return changed(result) === 1
}

/**
 * Verifies an idempotent replay or an adoption-loss acknowledgement against
 * the exact adopted identity, mutating nothing. A receipt is returned only
 * after the recorded key is re-derived from the operation's adopted/legacy
 * identity and the object's existence, size, and ciphertext hash are proven.
 * An authoritative mismatch never returns success; indeterminate proof fails
 * safely without changing state so the caller may retry.
 */
async function verifySealedReplay(
  row: ArtifactIntakeOperationRow,
  plaintextHash: string,
  env: Env,
): Promise<ArtifactUploadReceipt> {
  if (plaintextHash !== row.plaintext_sha256 || !row.ciphertext_sha256) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
  }
  const proof = await proveManagedArtifactCiphertext({
    env,
    tenantId: row.tenant_id,
    uploadId: row.upload_id,
    recordedKey: row.r2_key,
    adoptedAttemptToken: row.adopted_attempt_token,
    expectedCiphertextByteLength: Number(row.ciphertext_byte_length),
    expectedCiphertextSha256: row.ciphertext_sha256,
  })
  if (proof.status === 'verified') return toReceipt(row)
  throw new ArtifactIntakeContractError(
    proof.status === 'authoritative_mismatch'
      ? ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID
      : ARTIFACT_INTAKE_ERROR.INVALID_STATE,
  )
}

async function claimUploadAttempt(
  row: ArtifactIntakeOperationRow,
  attemptToken: string,
  env: Env,
): Promise<void> {
  const now = Date.now()
  const claimed = await env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET upload_attempt_token = ?, upload_attempt_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status IN ('reserved', 'failed')
       AND expiry_claim_token IS NULL AND finalization_id IS NULL AND expires_at > ?
       AND (upload_attempt_token IS NULL OR upload_attempt_expires_at <= ?)`,
  ).bind(
    attemptToken, now + ARTIFACT_UPLOAD_ATTEMPT_LEASE_MS, now,
    row.tenant_id, row.upload_id, now, now,
  ).run()
  if (changed(claimed) !== 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
}

async function recoverExistingCiphertext(args: {
  row: ArtifactIntakeOperationRow
  key: CryptoKey
  family: 'tmk' | 'kek'
  attemptToken: string
  plaintextHash: string
  env: Env
  detectedMimeType: string
}): Promise<ArtifactUploadReceipt | null> {
  try {
    // The legacy per-upload object, if genuine, is exactly this operation's
    // recorded plaintext length plus the sealed-envelope overhead; anything
    // else is rejected before a single body byte is materialized.
    const existing = await readManagedArtifactCiphertext(
      args.env,
      args.row.r2_key,
      Number(args.row.byte_length) + ARTIFACT_CIPHERTEXT_ENVELOPE_OVERHEAD_BYTES,
    )
    if (!existing) return null
    const plaintext = await unsealArtifactBytes(existing, args.key, args.family)
    if (await sha256Bytes(plaintext) !== args.plaintextHash) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
    }
    const adopted = await adoptUploadedCiphertext({
      row: args.row, env: args.env, attemptToken: args.attemptToken,
      detectedMimeType: args.detectedMimeType, family: args.family,
      ciphertextSha256: await sha256Bytes(existing),
      ciphertextByteLength: existing.byteLength,
      adoptedKey: null,
    })
    if (!adopted) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    return getArtifactIntakeStatus({ tenantId: args.row.tenant_id, uploadId: args.row.upload_id }, args.env)
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError && error.code === ARTIFACT_INTAKE_ERROR.INVALID_STATE) {
      throw error
    }
    await markUploadFailed(
      args.env, args.row, args.attemptToken,
      error instanceof ArtifactIntakeContractError ? error.code : ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID,
    ).catch(() => undefined)
    throw error
  }
}

export async function uploadArtifactBytes(args: {
  tenantId: string
  uploadId: string
  bytes: Uint8Array
  detectedMimeType: string
  declaredMimeType?: string | null
  encryptionFamily: 'tmk' | 'kek'
  key: CryptoKey
}, env: Env): Promise<ArtifactUploadReceipt> {
  const row = await getArtifactIntakeOperation(env, args.tenantId, args.uploadId)
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.NOT_FOUND)
  if (row.status === 'expired' || (row.status !== 'finalized' && Number(row.expires_at) <= Date.now())) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  if (args.bytes.byteLength !== Number(row.byte_length)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
  }
  const plaintextHash = await sha256Bytes(args.bytes)
  if (plaintextHash !== row.plaintext_sha256) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
  }
  resolveArtifactMimeType({ declaredMimeType: args.declaredMimeType, detectedMimeType: args.detectedMimeType })
  if (row.declared_mime_category && row.declared_mime_category !== mimeCategory(args.detectedMimeType)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.MIME_MISMATCH)
  }

  if (row.status === 'finalized') return toReceipt(row)
  if (row.status === 'sealed') return verifySealedReplay(row, plaintextHash, env)
  if (row.expiry_claim_token || row.finalization_id) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }

  const attemptToken = crypto.randomUUID()
  await claimUploadAttempt(row, attemptToken, env)
  if (!row.adopted_attempt_token && await managedArtifactExists(env, row.r2_key)) {
    const recovered = await recoverExistingCiphertext({
      row, env, key: args.key, family: args.encryptionFamily,
      attemptToken, plaintextHash, detectedMimeType: args.detectedMimeType,
    })
    if (recovered) return recovered
  }

  // Legacy rows keep writing the legacy per-upload key so an overlapping
  // pre-ownership Worker and this Worker always agree on one object per
  // operation. Attempt keys are enabled only on rows reserved under the
  // activated protocol, which no old writer can ever hold (migration 1033).
  const fenced = isFencedUploadProtocol(row.upload_protocol)
  const sealed = await sealArtifactBytes(args.bytes, args.key, args.encryptionFamily)
  const targetKey = fenced
    ? await managedArtifactAttemptR2Key(args.tenantId, args.uploadId, attemptToken)
    : row.r2_key
  if (fenced) {
    const now = Date.now()
    await recordUploadAttemptIntent(env, {
      tenantId: args.tenantId, uploadId: args.uploadId, attemptToken,
      leaseExpiresAt: now + ARTIFACT_UPLOAD_ATTEMPT_LEASE_MS, now,
    })
  }
  try {
    // Each fenced attempt writes only its own immutable key; adopted objects
    // are never overwritten by any later or slower writer.
    await putManagedArtifactCiphertext(env, targetKey, sealed.envelope)
  } catch {
    await markUploadFailed(env, row, attemptToken, ARTIFACT_INTAKE_ERROR.STORAGE_WRITE_FAILED)
      .catch(() => undefined)
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.STORAGE_WRITE_FAILED)
  }
  let adopted: boolean
  try {
    adopted = await adoptUploadedCiphertext({
      row, env, attemptToken, detectedMimeType: args.detectedMimeType,
      family: args.encryptionFamily, ciphertextSha256: sealed.ciphertextSha256,
      ciphertextByteLength: sealed.envelope.byteLength,
      adoptedKey: fenced ? targetKey : null,
    })
  } catch (error) {
    // The adoption response is ambiguous: it may or may not have committed.
    // Cleanup deletes this attempt's unique object only when authoritative D1
    // state proves the attempt was decided against; on any uncertainty the
    // object and its journal row stay for the crash-safe sweeper.
    if (fenced) {
      const outcome = await cleanupLosingUploadAttempt(env, {
        tenantId: args.tenantId, uploadId: args.uploadId, attemptToken, mode: 'ambiguous',
      })
      if (outcome === 'kept_adopted') {
        return acknowledgeAdoptedOperation(env, args.tenantId, args.uploadId, plaintextHash)
      }
    }
    throw error
  }
  if (adopted) {
    if (fenced) {
      await clearUploadAttemptIntent(env, args.tenantId, args.uploadId, attemptToken)
        .catch(() => undefined)
    }
    return getArtifactIntakeStatus({ tenantId: args.tenantId, uploadId: args.uploadId }, env)
  }
  // Adoption definitively lost: this attempt's object can never become
  // canonical, so its unique key is deleted immediately, and the winner is
  // acknowledged only after exact proof of the adopted identity.
  if (fenced) {
    await cleanupLosingUploadAttempt(env, {
      tenantId: args.tenantId, uploadId: args.uploadId, attemptToken, mode: 'lost',
    })
  }
  return acknowledgeAdoptedOperation(env, args.tenantId, args.uploadId, plaintextHash)
}

/**
 * Post-loss acknowledgement. Success requires rereading the operation and
 * proving its recorded key, adopted token, object existence, ciphertext size,
 * and ciphertext hash; an authoritative mismatch or indeterminate proof never
 * acknowledges and never mutates state (see verifySealedReplay).
 */
async function acknowledgeAdoptedOperation(
  env: Env,
  tenantId: string,
  uploadId: string,
  plaintextHash: string,
): Promise<ArtifactUploadReceipt> {
  const current = await getArtifactIntakeOperation(env, tenantId, uploadId)
  if (!current || (current.status !== 'sealed' && current.status !== 'finalized')) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  return verifySealedReplay(current, plaintextHash, env)
}

function uniqueUploadIds(uploadIds: string[]): string[] {
  const unique = [...new Set(uploadIds)]
  if (unique.length === 0 || unique.length !== uploadIds.length) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  return unique
}

function changed(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0)
}

export async function loadArtifactOperationsForFinalization(args: {
  tenantId: string
  finalizationId: string
  expectedOperationCount: number
}, env: Env): Promise<ArtifactIntakeOperationRow[]> {
  // Persisted or corrupt state must never drive unbounded D1 or proof work:
  // the expected count is bounded by the documented manifest maximum and the
  // query can never return more than one row past it.
  if (
    !Number.isInteger(args.expectedOperationCount) ||
    args.expectedOperationCount < 1 ||
    args.expectedOperationCount > ARTIFACT_MANIFEST_MAX_COUNT
  ) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
  }
  const rows = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations
     WHERE tenant_id = ? AND finalization_id = ? ORDER BY upload_id ASC LIMIT ?`,
  ).bind(args.tenantId, args.finalizationId, ARTIFACT_MANIFEST_MAX_COUNT + 1)
    .all<ArtifactIntakeOperationRow>()
  if (rows.results.length > args.expectedOperationCount) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED)
  }
  if (rows.results.length !== args.expectedOperationCount) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  return rows.results
}

export async function acquireArtifactFinalizationLease(args: {
  tenantId: string
  finalizationId: string
  leaseOwner: string
  expectedOperationCount: number
  captureId: string
  documentId: string
  operationId: string
  now: number
  leaseMs?: number
  recoveryMs?: number
  allowExpiredRecoveryProof?: boolean
}, env: Env): Promise<{ leaseExpiresAt: number; recoveryExpiresAt: number }> {
  const leaseMs = args.leaseMs ?? ARTIFACT_FINALIZATION_LEASE_MS
  const recoveryMs = args.recoveryMs ?? ARTIFACT_FINALIZATION_RECOVERY_MS
  if (!args.allowExpiredRecoveryProof && recoveryMs < leaseMs) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const leaseExpiresAt = args.now + leaseMs
  const initialRecoveryExpiresAt = args.allowExpiredRecoveryProof
    ? leaseExpiresAt
    : args.now + recoveryMs
  const activeLease = env.D1_US.prepare(
    `UPDATE artifact_intake_finalizations
     SET lease_owner = ?, lease_expires_at = ?, recovery_expires_at = COALESCE(recovery_expires_at, ?), updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status = 'reserved'
       AND expected_operation_count = ?
       AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
       AND (lease_owner = ? OR lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND (recovery_expires_at IS NULL OR recovery_expires_at >= ?)`,
  )
  const proofBackedStaleLease = env.D1_US.prepare(
    `UPDATE artifact_intake_finalizations
     SET lease_owner = ?, lease_expires_at = ?, recovery_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status = 'reserved'
       AND expected_operation_count = ?
       AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND recovery_expires_at IS NOT NULL AND recovery_expires_at <= ?`,
  )
  const result = await (args.allowExpiredRecoveryProof ? proofBackedStaleLease : activeLease).bind(
    args.leaseOwner, leaseExpiresAt, initialRecoveryExpiresAt, args.now,
    args.tenantId, args.finalizationId, args.expectedOperationCount,
    args.captureId, args.documentId, args.operationId,
    ...(args.allowExpiredRecoveryProof
      ? [args.now, args.now]
      : [args.leaseOwner, args.now, leaseExpiresAt]),
  ).run()
  if (changed(result) !== 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const leased = await env.D1_US.prepare(
    `SELECT recovery_expires_at FROM artifact_intake_finalizations
     WHERE tenant_id = ? AND id = ? AND lease_owner = ? LIMIT 1`,
  ).bind(args.tenantId, args.finalizationId, args.leaseOwner)
    .first<{ recovery_expires_at: number }>()
  if (!leased) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  return { leaseExpiresAt, recoveryExpiresAt: Number(leased.recovery_expires_at) }
}

export async function markArtifactOperationsForFinalize(args: {
  tenantId: string
  finalizationId: string
  leaseOwner: string
  uploadIds: string[]
  captureId: string
  documentId: string
  operationId: string
  now: number
  protectedUntil: number
}, env: Env): Promise<void> {
  const uploadIds = uniqueUploadIds(args.uploadIds)
  const placeholders = uploadIds.map(() => '?').join(', ')
  const exactPointers = `(canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?)`
  const eligible = `tenant_id = ? AND upload_id IN (${placeholders})
    AND status IN ('sealed', 'finalized') AND (status = 'finalized' OR expires_at > ?)
    AND expiry_claim_token IS NULL
    AND (finalization_id IS NULL OR finalization_id = ?)
    AND ((canonical_capture_id IS NULL AND canonical_document_id IS NULL AND canonical_operation_id IS NULL)
      OR ${exactPointers})
    AND (status != 'finalized' OR ${exactPointers})`
  const eligibleBindings = [
    args.tenantId, ...uploadIds, args.now + ARTIFACT_FINALIZATION_LEASE_MS,
    args.finalizationId,
    args.captureId, args.documentId, args.operationId,
    args.captureId, args.documentId, args.operationId,
  ]
  const finalizationGuard = `EXISTS (
    SELECT 1 FROM artifact_intake_finalizations f
    WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'reserved'
      AND f.expected_operation_count = ? AND f.lease_owner = ? AND f.lease_expires_at > ?
      AND f.recovery_expires_at >= ?
      AND f.canonical_capture_id = ? AND f.canonical_document_id = ? AND f.canonical_operation_id = ?
  )`
  const finalizationBindings = [
    args.tenantId, args.finalizationId, uploadIds.length, args.leaseOwner, args.now,
    args.protectedUntil, args.captureId, args.documentId, args.operationId,
  ]
  const bindSql = `UPDATE artifact_intake_operations
     SET finalization_id = ?, finalization_protected_until = ?, expires_at = MAX(expires_at, ?),
         canonical_capture_id = ?, canonical_document_id = ?, canonical_operation_id = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id IN (${placeholders})
       AND (SELECT COUNT(*) FROM artifact_intake_operations WHERE ${eligible}) = ?
       AND ${finalizationGuard}
       AND status IN ('sealed', 'finalized') AND (status = 'finalized' OR expires_at > ?) AND expiry_claim_token IS NULL
       AND (finalization_id IS NULL OR finalization_id = ?)`
  const result = await env.D1_US.prepare(bindSql).bind(
    args.finalizationId, args.protectedUntil, args.protectedUntil,
    args.captureId, args.documentId, args.operationId, args.now,
    args.tenantId, ...uploadIds,
    ...eligibleBindings, uploadIds.length,
    ...finalizationBindings,
    args.now + ARTIFACT_FINALIZATION_LEASE_MS, args.finalizationId,
  ).run()
  if (changed(result) !== uploadIds.length) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
}

export async function markArtifactOperationsFinalized(args: {
  tenantId: string
  finalizationId: string
  leaseOwner: string
  uploadIds: string[]
  captureId: string
  documentId: string
  operationId: string
  now: number
}, env: Env): Promise<void> {
  const uploadIds = uniqueUploadIds(args.uploadIds)
  const placeholders = uploadIds.map(() => '?').join(', ')
  const ownership = `tenant_id = ? AND upload_id IN (${placeholders})
    AND status IN ('sealed', 'finalized') AND finalization_id = ? AND expiry_claim_token IS NULL
    AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?`
  const ownershipBindings = [
    args.tenantId, ...uploadIds, args.finalizationId,
    args.captureId, args.documentId, args.operationId,
  ]
  const finalizeSql = `UPDATE artifact_intake_operations
     SET status = 'finalized', error_code = NULL, finalization_protected_until = NULL,
         expiry_claim_token = NULL, expiry_claim_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND upload_id IN (${placeholders})
       AND (SELECT COUNT(*) FROM artifact_intake_operations WHERE ${ownership}) = ?
       AND finalization_id = ? AND expiry_claim_token IS NULL
       AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
       AND EXISTS (
         SELECT 1 FROM artifact_intake_finalizations f
         WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'reserved'
           AND f.expected_operation_count = ? AND f.lease_owner = ? AND f.lease_expires_at > ?
       )`
  const result = await env.D1_US.prepare(finalizeSql).bind(
    args.now, args.tenantId, ...uploadIds,
    ...ownershipBindings, uploadIds.length,
    args.finalizationId, args.captureId, args.documentId, args.operationId,
    args.tenantId, args.finalizationId, uploadIds.length, args.leaseOwner, args.now,
  ).run()
  if (changed(result) !== uploadIds.length) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
}

/**
 * Repairs the only allowed post-acknowledgement split: the parent is already
 * finalized while one or more exact child rows remain sealed.
 */
export async function markArtifactOperationsFinalizedForCompletedFinalization(args: {
  tenantId: string
  finalizationId: string
  uploadIds: string[]
  captureId: string
  documentId: string
  operationId: string
  now: number
}, env: Env): Promise<void> {
  const uploadIds = uniqueUploadIds(args.uploadIds)
  const placeholders = uploadIds.map(() => '?').join(', ')
  // postflight-safe: placeholders contains only one parameter marker per validated upload ID.
  const result = await env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET status = 'finalized', error_code = NULL, finalization_protected_until = NULL,
         expiry_claim_token = NULL, expiry_claim_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND upload_id IN (${placeholders})
       AND status IN ('sealed', 'finalized') AND finalization_id = ? AND expiry_claim_token IS NULL
       AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
       AND EXISTS (
         SELECT 1 FROM artifact_intake_finalizations f
         WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'finalized'
           AND f.expected_operation_count = ?
       )`,
  ).bind(
    args.now, args.tenantId, ...uploadIds, args.finalizationId,
    args.captureId, args.documentId, args.operationId,
    args.tenantId, args.finalizationId, uploadIds.length,
  ).run()
  if (changed(result) !== uploadIds.length) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
}

/**
 * Atomically repairs a proof-backed failed-parent/sealed-child split. One D1
 * transaction finalizes the exact proven children first and promotes the
 * parent only when every bound operation is finalized and unclaimed, so the
 * parent can never become finalized while a child remains reaper-eligible.
 * If a reaper or another worker owns a child, zero rows change and the caller
 * must preserve state and retry.
 */
export async function repairFailedFinalizationWithProvenChildren(args: {
  tenantId: string
  finalizationId: string
  uploadIds: string[]
  captureId: string
  documentId: string
  operationId: string
  now: number
}, env: Env): Promise<'repaired' | 'retry'> {
  const uploadIds = uniqueUploadIds(args.uploadIds)
  const placeholders = uploadIds.map(() => '?').join(', ')
  const results = await env.D1_US.batch([
    // postflight-safe: placeholders contains only one parameter marker per validated upload ID.
    env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET status = 'finalized', error_code = NULL, finalization_protected_until = NULL,
           expiry_claim_token = NULL, expiry_claim_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND upload_id IN (${placeholders})
         AND status IN ('sealed', 'finalized') AND finalization_id = ?
         AND expiry_claim_token IS NULL
         AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM artifact_intake_finalizations f
           WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'failed'
             AND f.expected_operation_count = ?
         )`,
    ).bind(
      args.now, args.tenantId, ...uploadIds, args.finalizationId,
      args.captureId, args.documentId, args.operationId,
      args.tenantId, args.finalizationId, uploadIds.length,
    ),
    env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET status = 'finalized', error_code = NULL, lease_owner = NULL,
           lease_expires_at = NULL, recovery_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'failed'
         AND expected_operation_count = ?
         AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM artifact_intake_operations o
           WHERE o.tenant_id = ? AND o.finalization_id = ?
             AND (o.status != 'finalized' OR o.expiry_claim_token IS NOT NULL)
         )
         AND (
           SELECT COUNT(*) FROM artifact_intake_operations o
           WHERE o.tenant_id = ? AND o.finalization_id = ? AND o.status = 'finalized'
         ) = ?`,
    ).bind(
      args.now, args.tenantId, args.finalizationId, uploadIds.length,
      args.captureId, args.documentId, args.operationId,
      args.tenantId, args.finalizationId,
      args.tenantId, args.finalizationId, uploadIds.length,
    ),
  ])
  return changed(results[1]!) === 1 ? 'repaired' : 'retry'
}

export async function failArtifactFinalizationAndReleaseOperations(args: {
  tenantId: string
  finalizationId: string
  errorCode: string
  now: number
  expectedLeaseOwner?: string
}, env: Env): Promise<boolean> {
  const failFinalization = args.expectedLeaseOwner
    ? env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET status = 'failed', error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved' AND lease_owner = ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM artifact_intake_operations o
           WHERE o.tenant_id = ? AND o.finalization_id = ? AND o.status = 'finalized'
         )`,
    ).bind(
      args.errorCode, args.now, args.tenantId, args.finalizationId, args.expectedLeaseOwner,
      args.now, args.tenantId, args.finalizationId,
    )
    : env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET status = 'failed', error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved'
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM artifact_intake_operations o
           WHERE o.tenant_id = ? AND o.finalization_id = ? AND o.status = 'finalized'
         )`,
    ).bind(
      args.errorCode, args.now, args.tenantId, args.finalizationId,
      args.now, args.tenantId, args.finalizationId,
    )
  const results = await env.D1_US.batch([
    failFinalization,
    env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET finalization_id = NULL, finalization_protected_until = NULL,
           expires_at = MIN(expires_at, ?), updated_at = ?
       WHERE tenant_id = ? AND finalization_id = ? AND status != 'finalized'
         AND EXISTS (SELECT 1 FROM artifact_intake_finalizations f
           WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'failed')`,
    ).bind(args.now, args.now, args.tenantId, args.finalizationId, args.tenantId, args.finalizationId),
  ])
  return changed(results[0]!) === 1
}
