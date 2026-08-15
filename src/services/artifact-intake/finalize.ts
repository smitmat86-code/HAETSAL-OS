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
  getArtifactIntakeOperation,
  markArtifactOperationsFinalized,
  markArtifactOperationsForFinalize,
  type ArtifactIntakeOperationRow,
} from './operations'
import { finalizeArtifactCaptureSchema } from './schemas'

interface FinalizationRow {
  id: string
  tenant_id: string
  idempotency_hash: string
  manifest_sha256: string
  status: 'reserved' | 'finalized' | 'failed'
  error_code: string | null
  canonical_capture_id: string
  canonical_document_id: string
  canonical_operation_id: string
  created_at: number
  updated_at: number
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
): Promise<FinalizationRow> {
  const now = Date.now()
  const idempotencyHash = await sha256Text(input.idempotencyKey)
  const fingerprint = await manifestFingerprint(input)
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO artifact_intake_finalizations
     (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
      canonical_capture_id, canonical_document_id, canonical_operation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?)`,
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
  ).run()
  const row = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_finalizations WHERE tenant_id = ? AND idempotency_hash = ? LIMIT 1`,
  ).bind(input.tenantId, idempotencyHash).first<FinalizationRow>()
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  if (row.manifest_sha256 !== fingerprint) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  return row
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
  finalization: FinalizationRow,
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
    if (row.status === 'finalized' && row.canonical_capture_id !== finalization.canonical_capture_id) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    if (
      Number(row.byte_length) !== artifact.byteLength ||
      row.plaintext_sha256 !== artifact.plaintextSha256.toLowerCase() ||
      !row.ciphertext_sha256 ||
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
  finalization: FinalizationRow,
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
  row: FinalizationRow,
  uploadIds: string[],
  env: Env,
): Promise<void> {
  const now = Date.now()
  await markArtifactOperationsFinalized({
    tenantId: row.tenant_id,
    uploadIds,
    captureId: row.canonical_capture_id,
    documentId: row.canonical_document_id,
    operationId: row.canonical_operation_id,
    now,
  }, env)
  await env.D1_US.prepare(
    `UPDATE artifact_intake_finalizations
     SET status = 'finalized', error_code = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
  ).bind(now, row.tenant_id, row.id).run()
}

export async function finalizeArtifactCapture(
  input: FinalizeArtifactCaptureInput,
  contentKey: CryptoKey,
  env: Env,
): Promise<FinalizeArtifactCaptureReceipt> {
  validateManifestContract(input)
  const finalization = await reserveFinalization(input, env)
  const operations = await loadSealedOperations(input, finalization, env)
  const manifest = buildManifest(input, operations)
  const uploadIds = input.artifacts.map(artifact => artifact.uploadId)

  const store = getCanonicalMemoryStore(env)
  const existingCapture = await store.getCapture(input.tenantId, finalization.canonical_capture_id)
  if (existingCapture) {
    const existingDocument = await store.getDocument(input.tenantId, finalization.canonical_document_id)
    if (!existingDocument) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    await markFinalizationComplete(finalization, uploadIds, env)
    return receiptFor(finalization, manifest, input)
  }

  await markArtifactOperationsForFinalize({
    tenantId: input.tenantId,
    uploadIds,
    captureId: finalization.canonical_capture_id,
    documentId: finalization.canonical_document_id,
    operationId: finalization.canonical_operation_id,
    now: Date.now(),
  }, env)

  const refs: CanonicalArtifactRef[] = manifest.map((artifact, index) => ({
    artifactId: artifact.artifactId,
    mode: 'stored_r2',
    storageKind: 'managed_r2',
    storageKey: operations.get(artifact.uploadId)!.r2_key,
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

  try {
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
  } catch {
    await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations SET status = 'failed', error_code = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status != 'finalized'`,
    ).bind(ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED, Date.now(), input.tenantId, finalization.id).run().catch(() => undefined)
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED)
  }

  await markFinalizationComplete(finalization, uploadIds, env)
  return receiptFor(finalization, manifest, input)
}
