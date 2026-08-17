import type { Env } from '../../types/env'
import type {
  ArtifactManifestReceipt,
  FinalizeArtifactCaptureInput,
  FinalizeArtifactCaptureReceipt,
} from '../../types/artifact-intake'
import type { CanonicalArtifactRef } from '../../types/canonical-memory'
import { encryptContentForArchive } from '../ingestion/encryption'
import { captureCanonicalMemory } from '../canonical-memory'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  resolveArtifactMimeType,
} from './contracts'
import { sha256Text } from './crypto'
import {
  acquireArtifactFinalizationLease,
  failArtifactFinalizationAndReleaseOperations,
  getArtifactIntakeOperation,
  loadArtifactOperationsForFinalization,
  markArtifactOperationsFinalized,
  markArtifactOperationsFinalizedForCompletedFinalization,
  markArtifactOperationsForFinalize,
  type ArtifactIntakeOperationRow,
} from './operations'
import { artifactManifestIdentitySha256 } from './manifest-identity'
import { finalizeArtifactCaptureSchema } from './schemas'
import { proveManagedArtifactCiphertext } from './storage'
import { proveArtifactFinalizationCanonicalSuccess } from './finalization-proof'
import {
  artifactProofIndeterminate,
  artifactProofMismatch,
  type ArtifactProofResult,
  verifiedArtifactProof,
} from './proof-result'

export interface ArtifactFinalizationRow {
  id: string
  tenant_id: string
  idempotency_hash: string
  manifest_sha256: string
  artifact_manifest_sha256: string | null
  status: 'reserved' | 'finalized' | 'failed'
  error_code: string | null
  canonical_capture_id: string
  canonical_document_id: string
  canonical_operation_id: string
  expected_operation_count: number
  lease_owner: string | null
  lease_expires_at: number | null
  recovery_expires_at: number | null
  created_at: number
  updated_at: number
}

export interface FinalizeArtifactCaptureFence {
  /**
   * Runs after the idempotent reservation is visible and immediately before
   * any artifact-operation mutation or canonical write. Channel callers use
   * this to prove that their exact processing lease is still owned.
   */
  beforeCanonicalSideEffects?: () => void | Promise<void>
  /** Deterministic crash/race hook used after all operations are protected. */
  afterOperationsProtected?: () => void | Promise<void>
}

async function manifestFingerprint(input: FinalizeArtifactCaptureInput): Promise<string> {
  return sha256Text(JSON.stringify({
    contentSha256: await sha256Text(input.content),
    scope: input.scope,
    title: input.title ?? null,
    sourceRef: input.sourceRef ?? null,
    clientName: input.clientName,
    agentIdentity: input.agentIdentity ?? input.clientName,
    sourceSystem: input.sourceSystem ?? 'file',
    authorKind: input.authorKind ?? 'external_client',
    modelRuntime: input.modelRuntime ?? null,
    artifacts: input.artifacts.map(artifact => ({
      uploadId: artifact.uploadId,
      role: artifact.role,
      parentUploadId: artifact.parentUploadId ?? null,
      primary: artifact.primary,
      detectedMimeType: artifact.detectedMimeType.toLowerCase(),
      byteLength: artifact.byteLength,
      plaintextSha256: artifact.plaintextSha256.toLowerCase(),
    })),
  }))
}

async function reserveFinalization(
  input: FinalizeArtifactCaptureInput,
  env: Env,
): Promise<{ row: ArtifactFinalizationRow; created: boolean }> {
  const now = Date.now()
  const idempotencyHash = await sha256Text(input.idempotencyKey)
  const fingerprint = await manifestFingerprint(input)
  const artifactManifestSha256 = await artifactManifestIdentitySha256(input.artifacts.map(artifact => ({
    uploadId: artifact.uploadId, role: artifact.role,
    parentUploadId: artifact.parentUploadId ?? null, primary: artifact.primary,
    mediaType: resolveArtifactMimeType({
      declaredMimeType: artifact.declaredMimeType,
      detectedMimeType: artifact.detectedMimeType,
    }),
    byteLength: artifact.byteLength,
    plaintextSha256: artifact.plaintextSha256,
  })))
  const inserted = await env.D1_US.prepare(
    `INSERT OR IGNORE INTO artifact_intake_finalizations
     (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
      canonical_capture_id, canonical_document_id, canonical_operation_id, created_at, updated_at,
      expected_operation_count, artifact_manifest_sha256,
      lease_owner, lease_expires_at, recovery_expires_at)
     VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).bind(
    crypto.randomUUID(),
    input.tenantId,
    idempotencyHash,
    fingerprint,
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    now,
    now,
    input.artifacts.length,
    artifactManifestSha256,
  ).run()
  const row = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_finalizations WHERE tenant_id = ? AND idempotency_hash = ? LIMIT 1`,
  ).bind(input.tenantId, idempotencyHash).first<ArtifactFinalizationRow>()
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  if (row.manifest_sha256 !== fingerprint) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  if (Number(row.expected_operation_count) !== input.artifacts.length) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  if (row.artifact_manifest_sha256 === null) {
    const upgraded = await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations SET artifact_manifest_sha256 = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND artifact_manifest_sha256 IS NULL AND manifest_sha256 = ?`,
    ).bind(artifactManifestSha256, now, input.tenantId, row.id, fingerprint).run()
    const persisted = Number(upgraded.meta.changes ?? 0) === 1
      ? artifactManifestSha256
      : await env.D1_US.prepare(
        `SELECT artifact_manifest_sha256 FROM artifact_intake_finalizations
         WHERE tenant_id = ? AND id = ? LIMIT 1`,
      ).bind(input.tenantId, row.id).first<string>('artifact_manifest_sha256')
    if (persisted !== artifactManifestSha256) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    row.artifact_manifest_sha256 = persisted
  }
  if (row.artifact_manifest_sha256 !== artifactManifestSha256) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  return { row, created: Number(inserted.meta.changes ?? 0) === 1 }
}

function validateManifestContract(input: FinalizeArtifactCaptureInput): void {
  const result = finalizeArtifactCaptureSchema.safeParse({
    tenant_id: input.tenantId,
    searchable_content: input.content,
    declared_derivative_upload_ids: input.declaredDerivativeUploadIds ?? [],
    artifacts: input.artifacts.map(artifact => ({
      upload_id: artifact.uploadId,
      tenant_id: input.tenantId,
      role: artifact.role,
      parent_upload_id: artifact.parentUploadId ?? undefined,
      primary: artifact.primary,
      byte_length: artifact.byteLength,
    })),
  })
  if (!result.success) {
    const code = result.error.issues[0]?.message
    const known = Object.values(ARTIFACT_INTAKE_ERROR).find(value => value === code)
    throw new ArtifactIntakeContractError(known ?? ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
}

async function loadSealedOperations(
  input: FinalizeArtifactCaptureInput,
  finalization: ArtifactFinalizationRow,
  env: Env,
): Promise<Map<string, ArtifactIntakeOperationRow>> {
  const rows = new Map<string, ArtifactIntakeOperationRow>()
  for (const artifact of input.artifacts) {
    const row = await getArtifactIntakeOperation(env, input.tenantId, artifact.uploadId)
    // Tenant-scoped lookup deliberately makes foreign and absent uploads indistinguishable.
    if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.NOT_FOUND)
    if (row.status !== 'sealed' && row.status !== 'finalized') {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    if (row.finalization_id && row.finalization_id !== finalization.id) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    if (row.status === 'finalized' && (
      row.finalization_id !== finalization.id ||
      row.canonical_capture_id !== finalization.canonical_capture_id ||
      row.canonical_document_id !== finalization.canonical_document_id ||
      row.canonical_operation_id !== finalization.canonical_operation_id
    )) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    if (
      Number(row.byte_length) !== artifact.byteLength ||
      row.plaintext_sha256 !== artifact.plaintextSha256.toLowerCase() ||
      !row.ciphertext_sha256 ||
      !Number.isInteger(Number(row.ciphertext_byte_length)) || Number(row.ciphertext_byte_length) <= 0 ||
      !row.encryption_family
    ) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
    }
    resolveArtifactMimeType({
      declaredMimeType: artifact.declaredMimeType,
      detectedMimeType: artifact.detectedMimeType,
    })
    rows.set(artifact.uploadId, row)
  }
  return rows
}

function buildManifest(
  input: FinalizeArtifactCaptureInput,
  rows: Map<string, ArtifactIntakeOperationRow>,
): ArtifactManifestReceipt[] {
  return input.artifacts.map(artifact => {
    const row = rows.get(artifact.uploadId)!
    const parentArtifactId = artifact.parentUploadId
      ? rows.get(artifact.parentUploadId)?.artifact_id ?? null
      : null
    return {
      artifactId: row.artifact_id,
      uploadId: row.upload_id,
      role: artifact.role,
      parentArtifactId,
      primary: artifact.primary,
      mediaType: resolveArtifactMimeType({
        declaredMimeType: artifact.declaredMimeType,
        detectedMimeType: artifact.detectedMimeType,
      }),
      byteLength: Number(row.byte_length),
      plaintextSha256: row.plaintext_sha256,
      ciphertextSha256: row.ciphertext_sha256!,
      encryptionFamily: row.encryption_family!,
    }
  })
}

function receiptFor(
  finalization: ArtifactFinalizationRow,
  manifest: ArtifactManifestReceipt[],
  input: FinalizeArtifactCaptureInput,
): FinalizeArtifactCaptureReceipt {
  return {
    status: 'finalized',
    captureId: finalization.canonical_capture_id,
    documentId: finalization.canonical_document_id,
    operationId: finalization.canonical_operation_id,
    primaryArtifactId: manifest.find(artifact => artifact.primary)!.artifactId,
    artifacts: manifest,
    clientName: input.clientName,
    agentIdentity: input.agentIdentity ?? input.clientName,
  }
}

async function markFinalizationComplete(
  row: ArtifactFinalizationRow,
  uploadIds: string[],
  leaseOwner: string,
  env: Env,
): Promise<void> {
  const now = Date.now()
  await markArtifactOperationsFinalized({
    tenantId: row.tenant_id,
    finalizationId: row.id,
    leaseOwner,
    uploadIds,
    captureId: row.canonical_capture_id,
    documentId: row.canonical_document_id,
    operationId: row.canonical_operation_id,
    now,
  }, env)
  await env.D1_US.prepare(
    `UPDATE artifact_intake_finalizations
     SET status = 'finalized', error_code = NULL, lease_owner = NULL,
         lease_expires_at = NULL, recovery_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status = 'reserved'
       AND lease_owner = ? AND lease_expires_at > ?`,
  ).bind(now, row.tenant_id, row.id, leaseOwner, now).run().then(result => {
    if (Number(result.meta.changes ?? 0) !== 1) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
    }
  })
}

async function assertFinalizationLease(
  row: ArtifactFinalizationRow,
  leaseOwner: string,
  env: Env,
): Promise<void> {
  const owned = await env.D1_US.prepare(
    `SELECT id FROM artifact_intake_finalizations
     WHERE tenant_id = ? AND id = ? AND status = 'reserved'
       AND lease_owner = ? AND lease_expires_at > ? LIMIT 1`,
  ).bind(row.tenant_id, row.id, leaseOwner, Date.now()).first<{ id: string }>()
  if (!owned) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
}

async function proveRawOperations(
  rows: Map<string, ArtifactIntakeOperationRow>,
  env: Env,
): Promise<ArtifactProofResult> {
  for (const row of rows.values()) {
    if (!row.ciphertext_sha256 || !row.ciphertext_byte_length || !row.encryption_family) {
      return artifactProofMismatch('operation_metadata_mismatch')
    }
    if (row.expiry_claim_token) {
      return artifactProofMismatch('operation_metadata_mismatch')
    }
    const proof = await proveManagedArtifactCiphertext({
      env,
      tenantId: row.tenant_id,
      uploadId: row.upload_id,
      recordedKey: row.r2_key,
      expectedCiphertextByteLength: Number(row.ciphertext_byte_length),
      expectedCiphertextSha256: row.ciphertext_sha256,
    })
    if (proof.status !== 'verified') return proof
  }
  return verifiedArtifactProof(undefined)
}

async function assertCanonicalProof(args: {
  input: FinalizeArtifactCaptureInput
  finalization: ArtifactFinalizationRow
  manifest: ArtifactManifestReceipt[]
  operations: Map<string, ArtifactIntakeOperationRow>
  env: Env
}): Promise<ArtifactProofResult> {
  const store = getCanonicalMemoryStore(args.env)
  let capture
  let document
  let operation
  try {
    capture = await store.getCapture(args.input.tenantId, args.finalization.canonical_capture_id)
    document = await store.getDocument(args.input.tenantId, args.finalization.canonical_document_id)
    operation = await store.getOperationById(args.input.tenantId, args.finalization.canonical_operation_id)
  } catch {
    return artifactProofIndeterminate('canonical_store_unavailable')
  }
  const primary = args.manifest.filter(item => item.primary)
  if (!capture || !document || !operation) return artifactProofMismatch('canonical_record_missing')
  if (
    primary.length !== 1 ||
    capture.source_system !== (args.input.sourceSystem ?? 'file') ||
    capture.source_ref !== (args.input.sourceRef ?? null) ||
    capture.artifact_id !== primary[0]!.artifactId ||
    document.capture_id !== capture.id || document.artifact_id !== primary[0]!.artifactId ||
    document.body_r2_key !== capture.body_r2_key ||
    operation.capture_id !== capture.id || operation.status !== 'accepted' ||
    document.artifact_manifest.length !== args.manifest.length
  ) return artifactProofMismatch('canonical_metadata_mismatch')

  for (let index = 0; index < args.manifest.length; index += 1) {
    const expected = args.manifest[index]!
    const actual = document.artifact_manifest[index]
    if (
      !actual || actual.ordinal !== index || actual.artifact_id !== expected.artifactId ||
      actual.role !== expected.role || actual.parent_artifact_id !== expected.parentArtifactId ||
      actual.primary !== expected.primary || actual.storage_kind !== 'managed_r2' ||
      actual.r2_key !== args.operations.get(expected.uploadId)?.r2_key ||
      actual.media_type !== expected.mediaType || Number(actual.byte_length) !== expected.byteLength ||
      actual.sha256 !== expected.plaintextSha256 || actual.cipher_sha256 !== expected.ciphertextSha256 ||
      actual.encryption_family !== expected.encryptionFamily
    ) return artifactProofMismatch('canonical_manifest_mismatch')
  }
  return verifiedArtifactProof(undefined)
}

class ArtifactProofError extends ArtifactIntakeContractError {
  constructor(readonly proof: Exclude<ArtifactProofResult, { status: 'verified' }>) {
    super(proof.status === 'indeterminate'
      ? ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED
      : ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
}

function requireVerifiedProof(proof: ArtifactProofResult, finalizedHistory = false): void {
  if (proof.status === 'verified') return
  if (finalizedHistory && proof.status === 'authoritative_mismatch') {
    console.error('ARTIFACT_INTEGRITY_INCIDENT', { reason: proof.reason })
  }
  throw new ArtifactProofError(proof)
}

export async function finalizeArtifactCapture(
  input: FinalizeArtifactCaptureInput,
  contentKey: CryptoKey,
  env: Env,
  fence: FinalizeArtifactCaptureFence = {},
): Promise<FinalizeArtifactCaptureReceipt> {
  validateManifestContract(input)
  const reservation = await reserveFinalization(input, env)
  const finalization = reservation.row
  const uploadIds = input.artifacts.map(artifact => artifact.uploadId)
  const store = getCanonicalMemoryStore(env)

  if (finalization.status === 'failed') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  if (finalization.status === 'finalized') {
    const operations = await loadSealedOperations(input, finalization, env)
    const manifest = buildManifest(input, operations)
    requireVerifiedProof(await proveRawOperations(operations, env), true)
    requireVerifiedProof(
      await assertCanonicalProof({ input, finalization, manifest, operations, env }), true,
    )
    if ([...operations.values()].some(row => row.status !== 'finalized')) {
      await markArtifactOperationsFinalizedForCompletedFinalization({
        tenantId: input.tenantId, finalizationId: finalization.id, uploadIds,
        captureId: finalization.canonical_capture_id,
        documentId: finalization.canonical_document_id,
        operationId: finalization.canonical_operation_id, now: Date.now(),
      }, env)
    }
    return receiptFor(finalization, manifest, input)
  }

  try {
    await fence.beforeCanonicalSideEffects?.()
  } catch (error) {
    if (reservation.created) {
      await failArtifactFinalizationAndReleaseOperations({
        tenantId: input.tenantId, finalizationId: finalization.id,
        errorCode: error instanceof ArtifactIntakeContractError
          ? error.code : ARTIFACT_INTAKE_ERROR.LEASE_LOST,
        now: Date.now(),
      }, env).catch(() => undefined)
    }
    throw error
  }

  const leaseOwner = crypto.randomUUID()
  let operations: Map<string, ArtifactIntakeOperationRow> | null = null
  try {
    const ownership = await acquireArtifactFinalizationLease({
      tenantId: input.tenantId, finalizationId: finalization.id, leaseOwner,
      expectedOperationCount: input.artifacts.length,
      captureId: finalization.canonical_capture_id,
      documentId: finalization.canonical_document_id,
      operationId: finalization.canonical_operation_id,
      now: Date.now(),
    }, env)

    const eligible = await loadSealedOperations(input, finalization, env)
    await markArtifactOperationsForFinalize({
      tenantId: input.tenantId, finalizationId: finalization.id, leaseOwner, uploadIds,
      captureId: finalization.canonical_capture_id,
      documentId: finalization.canonical_document_id,
      operationId: finalization.canonical_operation_id,
      now: Date.now(), protectedUntil: ownership.recoveryExpiresAt,
    }, env)
    const bound = await loadArtifactOperationsForFinalization({
      tenantId: input.tenantId, finalizationId: finalization.id,
      expectedOperationCount: input.artifacts.length,
    }, env)
    operations = new Map(bound.map(row => [row.upload_id, row]))
    if (operations.size !== eligible.size || uploadIds.some(uploadId => !operations!.has(uploadId))) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    requireVerifiedProof(await proveRawOperations(operations, env))
    await fence.afterOperationsProtected?.()
    await assertFinalizationLease(finalization, leaseOwner, env)

    const manifest = buildManifest(input, operations)
    const existingCapture = await store.getCapture(input.tenantId, finalization.canonical_capture_id)
    if (!existingCapture) {
      const refs: CanonicalArtifactRef[] = manifest.map((artifact, index) => ({
        artifactId: artifact.artifactId,
        mode: 'stored_r2',
        storageKind: 'managed_r2',
        storageKey: operations!.get(artifact.uploadId)!.r2_key,
        filename: input.artifacts[index]!.filename ?? null,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        sha256: artifact.plaintextSha256,
        cipherSha256: artifact.ciphertextSha256,
        encryptionFamily: artifact.encryptionFamily,
        role: artifact.role,
        parentArtifactId: artifact.parentArtifactId,
        primary: artifact.primary,
      }))
      await captureCanonicalMemory({
        tenantId: input.tenantId,
        captureId: finalization.canonical_capture_id,
        documentId: finalization.canonical_document_id,
        operationId: finalization.canonical_operation_id,
        sourceSystem: input.sourceSystem ?? 'file',
        sourceRef: input.sourceRef ?? null,
        scope: input.scope,
        title: input.title ?? null,
        body: input.content,
        bodyEncrypted: await encryptContentForArchive(input.content, contentKey),
        artifactRefs: refs,
        governance: {
          authorKind: input.authorKind ?? 'external_client',
          agentIdentity: input.agentIdentity ?? input.clientName,
          modelRuntime: input.modelRuntime ?? null,
          provenanceNote: input.provenance ?? null,
          memoryClass: 'episode',
          trustState: 'evidence',
          usePolicy: 'can_use_as_evidence',
        },
      }, env, input.tenantId)
    }

    await assertFinalizationLease(finalization, leaseOwner, env)
    requireVerifiedProof(await proveRawOperations(operations, env))
    requireVerifiedProof(await assertCanonicalProof({ input, finalization, manifest, operations, env }))
    await markFinalizationComplete(finalization, uploadIds, leaseOwner, env)
    return receiptFor(finalization, manifest, input)
  } catch (error) {
    if (operations) {
      const exactProof = await proveArtifactFinalizationCanonicalSuccess({
        finalization, operations: [...operations.values()], env,
      }).catch(() => artifactProofIndeterminate('canonical_store_unavailable') as ArtifactProofResult)
      if (exactProof.status === 'verified') {
        try {
          const current = await env.D1_US.prepare(
            `SELECT * FROM artifact_intake_finalizations
             WHERE tenant_id = ? AND id = ? LIMIT 1`,
          ).bind(input.tenantId, finalization.id).first<ArtifactFinalizationRow>()
          if (current?.status === 'finalized') {
            await markArtifactOperationsFinalizedForCompletedFinalization({
              tenantId: input.tenantId, finalizationId: finalization.id, uploadIds,
              captureId: finalization.canonical_capture_id,
              documentId: finalization.canonical_document_id,
              operationId: finalization.canonical_operation_id, now: Date.now(),
            }, env)
            return receiptFor(finalization, buildManifest(input, operations), input)
          }
          await markFinalizationComplete(finalization, uploadIds, leaseOwner, env)
          return receiptFor(finalization, buildManifest(input, operations), input)
        } catch {
          // Exact success is already durable. Preserve the recoverable split;
          // a retry re-reads and re-proves instead of writing failed history.
        }
      }
    }
    // Release only the processing lease so a retry can re-prove immediately.
    // Operation bindings, raw bytes, and recovery protection remain intact.
    await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved' AND lease_owner = ?`,
    ).bind(Date.now(), input.tenantId, finalization.id, leaseOwner).run().catch(() => undefined)
    if (error instanceof ArtifactIntakeContractError) throw error
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED)
  }
}
