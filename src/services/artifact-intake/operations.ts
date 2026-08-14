import type { Env } from '../../types/env'
import type {
  ArtifactEncryptionFamily,
  ArtifactUploadReceipt,
  ArtifactUploadState,
} from '../../types/artifact-intake'
import { ARTIFACT_MAX_BYTES, ARTIFACT_UPLOAD_EXPIRY_MS } from './config'
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
  encryption_family: Exclude<ArtifactEncryptionFamily, 'legacy_unsealed'> | null
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
           encryption_family = ?, updated_at = ?
       WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`,
    ).bind(
      mimeCategory(args.detectedMimeType),
      ciphertextHash,
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
         encryption_family = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`,
  ).bind(
    mimeCategory(args.detectedMimeType),
    sealed.ciphertextSha256,
    args.encryptionFamily,
    Date.now(),
    args.tenantId,
    args.uploadId,
  ).run()
  return getArtifactIntakeStatus({ tenantId: args.tenantId, uploadId: args.uploadId }, env)
}

export async function markArtifactOperationsForFinalize(args: {
  tenantId: string
  uploadIds: string[]
  captureId: string
  documentId: string
  operationId: string
  now: number
}, env: Env): Promise<void> {
  await env.D1_US.batch(args.uploadIds.map(uploadId => env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET canonical_capture_id = ?, canonical_document_id = ?, canonical_operation_id = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status IN ('sealed', 'finalized')`,
  ).bind(args.captureId, args.documentId, args.operationId, args.now, args.tenantId, uploadId)))
}

export async function markArtifactOperationsFinalized(args: {
  tenantId: string
  uploadIds: string[]
  captureId: string
  documentId: string
  operationId: string
  now: number
}, env: Env): Promise<void> {
  await env.D1_US.batch(args.uploadIds.map(uploadId => env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET status = 'finalized', error_code = NULL, canonical_capture_id = ?, canonical_document_id = ?,
         canonical_operation_id = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status != 'expired'`,
  ).bind(args.captureId, args.documentId, args.operationId, args.now, args.tenantId, uploadId)))
}
