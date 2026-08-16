import type { Env } from '../../types/env'
import type {
  ArtifactEncryptionFamily,
  ArtifactUploadReceipt,
  ArtifactUploadState,
} from '../../types/artifact-intake'
import {
  ARTIFACT_FINALIZATION_LEASE_MS,
  ARTIFACT_FINALIZATION_RECOVERY_MS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_UPLOAD_EXPIRY_MS,
} from './config'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  resolveArtifactMimeType,
} from './contracts'
import { sealArtifactBytes, sha256Bytes, sha256Text, unsealArtifactBytes } from './crypto'
import {
  managedArtifactExists,
  managedArtifactR2Key,
  putManagedArtifactCiphertext,
  readManagedArtifactCiphertext,
} from './storage'

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
      canonical_operation_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
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

async function markUploadFailed(
  env: Env,
  row: ArtifactIntakeOperationRow,
  errorCode: string,
): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET status = 'failed', error_code = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`,
  ).bind(errorCode, Date.now(), row.tenant_id, row.upload_id).run()
}

async function recoverExistingCiphertext(args: {
  row: ArtifactIntakeOperationRow
  key: CryptoKey
  family: 'tmk' | 'kek'
  bytes: Uint8Array
  env: Env
  detectedMimeType: string
}): Promise<ArtifactUploadReceipt | null> {
  const existing = await readManagedArtifactCiphertext(args.env, args.row.r2_key)
  if (!existing) return null
  try {
    const plaintext = await unsealArtifactBytes(existing, args.key, args.family)
    const plaintextHash = await sha256Bytes(plaintext)
    if (plaintextHash !== args.row.plaintext_sha256 || plaintextHash !== await sha256Bytes(args.bytes)) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
    }
    const ciphertextHash = await sha256Bytes(existing)
    const now = Date.now()
    await args.env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET status = 'sealed', error_code = NULL, detected_mime_category = ?, ciphertext_sha256 = ?,
           ciphertext_byte_length = ?,
           encryption_family = ?, updated_at = ?
       WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`,
    ).bind(
      mimeCategory(args.detectedMimeType),
      ciphertextHash,
      existing.byteLength,
      args.family,
      now,
      args.row.tenant_id,
      args.row.upload_id,
    ).run()
    return getArtifactIntakeStatus({ tenantId: args.row.tenant_id, uploadId: args.row.upload_id }, args.env)
  } catch (error) {
    await markUploadFailed(args.env, args.row, error instanceof ArtifactIntakeContractError ? error.code : ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
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
  if (await managedArtifactExists(env, row.r2_key)) {
    const recovered = await recoverExistingCiphertext({
      row,
      env,
      key: args.key,
      family: args.encryptionFamily,
      bytes: args.bytes,
      detectedMimeType: args.detectedMimeType,
    })
    if (recovered) return recovered
  }

  const sealed = await sealArtifactBytes(args.bytes, args.key, args.encryptionFamily)
  try {
    await putManagedArtifactCiphertext(env, row.r2_key, sealed.envelope)
  } catch {
    await markUploadFailed(env, row, ARTIFACT_INTAKE_ERROR.STORAGE_WRITE_FAILED).catch(() => undefined)
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.STORAGE_WRITE_FAILED)
  }
  await env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET status = 'sealed', error_code = NULL, detected_mime_category = ?, ciphertext_sha256 = ?,
         ciphertext_byte_length = ?,
         encryption_family = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`,
  ).bind(
    mimeCategory(args.detectedMimeType),
    sealed.ciphertextSha256,
    sealed.envelope.byteLength,
    args.encryptionFamily,
    Date.now(),
    args.tenantId,
    args.uploadId,
  ).run()
  return getArtifactIntakeStatus({ tenantId: args.tenantId, uploadId: args.uploadId }, env)
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
  const rows = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations
     WHERE tenant_id = ? AND finalization_id = ? ORDER BY upload_id ASC`,
  ).bind(args.tenantId, args.finalizationId).all<ArtifactIntakeOperationRow>()
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
  const leaseExpiresAt = args.now + (args.leaseMs ?? ARTIFACT_FINALIZATION_LEASE_MS)
  const initialRecoveryExpiresAt = args.now + (args.recoveryMs ?? ARTIFACT_FINALIZATION_RECOVERY_MS)
  const activeLease = env.D1_US.prepare(
    `UPDATE artifact_intake_finalizations
     SET lease_owner = ?, lease_expires_at = ?, recovery_expires_at = COALESCE(recovery_expires_at, ?), updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status = 'reserved'
       AND expected_operation_count = ?
       AND canonical_capture_id = ? AND canonical_document_id = ? AND canonical_operation_id = ?
       AND (lease_owner = ? OR lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND (recovery_expires_at IS NULL OR recovery_expires_at > ?)`,
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
    ...(args.allowExpiredRecoveryProof ? [args.now, args.now] : [args.leaseOwner, args.now, args.now]),
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
       WHERE tenant_id = ? AND id = ? AND status = 'reserved' AND lease_owner = ?`,
    ).bind(args.errorCode, args.now, args.tenantId, args.finalizationId, args.expectedLeaseOwner)
    : env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET status = 'failed', error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved'`,
    ).bind(args.errorCode, args.now, args.tenantId, args.finalizationId)
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
