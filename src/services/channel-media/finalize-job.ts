import type { Env } from '../../types/env'
import type {
  AcquiredChannelMedia,
  ChannelMediaDescriptor,
  ChannelMediaJob,
  PreparedChannelMediaCapture,
} from '../../types/channel-media'
import { CHANNEL_MEDIA_DESCRIPTION_MAX_CHARS } from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sha256Bytes } from '../artifact-intake/crypto'
import { finalizeArtifactCapture } from '../artifact-intake/finalize'
import {
  getArtifactIntakeOperation,
  getArtifactIntakeStatus,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../artifact-intake/operations'
import { markChannelMediaFinalized, renewChannelMediaLease } from './job-transitions'
import { writeChannelMediaRecovery } from './recovery'
export function channelMediaSearchableBody(
  descriptor: ChannelMediaDescriptor,
  description: string,
): string {
  return descriptor.caption
    ? `${descriptor.caption}\n\nPhoto: ${description}`
    : `Photo: ${description}`
}

export async function prepareChannelMediaCapture(args: {
  job: ChannelMediaJob
  acquired: AcquiredChannelMedia
  description: string
  tmk: CryptoKey
  env: Env
}): Promise<PreparedChannelMediaCapture> {
  if (!args.description || args.description.length > CHANNEL_MEDIA_DESCRIPTION_MAX_CHARS) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const plaintextSha256 = await sha256Bytes(args.acquired.bytes)
  const upload = await reserveArtifactUpload({
    tenantId: args.job.tenantId,
    idempotencyKey: `channel-media-upload:${args.job.id}`,
    byteLength: args.acquired.bytes.byteLength,
    plaintextSha256,
    declaredMimeType: args.acquired.declaredMimeType,
  }, args.env)
  const prepared = await writeChannelMediaRecovery({
    tenantId: args.job.tenantId,
    operationId: args.job.id,
    prepared: {
      version: 1,
      uploadId: upload.uploadId,
      description: args.description,
      detectedMimeType: args.acquired.detectedMimeType,
      declaredMimeType: args.acquired.declaredMimeType,
      byteLength: args.acquired.bytes.byteLength,
      plaintextSha256,
    },
    tmk: args.tmk,
  }, args.env)
  await ensurePreparedChannelMediaUpload({
    job: args.job, prepared, acquired: args.acquired, tmk: args.tmk, env: args.env,
  })
  return prepared
}

export async function ensurePreparedChannelMediaUpload(args: {
  job: ChannelMediaJob
  prepared: PreparedChannelMediaCapture
  acquired?: AcquiredChannelMedia
  tmk: CryptoKey
  env: Env
}): Promise<void> {
  const operation = await getArtifactIntakeOperation(args.env, args.job.tenantId, args.prepared.uploadId)
  if (!operation) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  if (operation.status === 'sealed' || operation.status === 'finalized') return
  if (!args.acquired) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
  if (
    args.acquired.bytes.byteLength !== args.prepared.byteLength ||
    await sha256Bytes(args.acquired.bytes) !== args.prepared.plaintextSha256 ||
    args.acquired.detectedMimeType !== args.prepared.detectedMimeType ||
    (args.acquired.declaredMimeType ?? undefined) !== args.prepared.declaredMimeType
  ) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH)
  await uploadArtifactBytes({
    tenantId: args.job.tenantId,
    uploadId: args.prepared.uploadId,
    bytes: args.acquired.bytes,
    detectedMimeType: args.prepared.detectedMimeType,
    declaredMimeType: args.prepared.declaredMimeType,
    encryptionFamily: 'tmk',
    key: args.tmk,
  }, args.env)
}

export async function finalizePreparedChannelMediaJob(args: {
  job: ChannelMediaJob
  descriptor: ChannelMediaDescriptor
  prepared: PreparedChannelMediaCapture
  leaseToken: string
  tmk: CryptoKey
  env: Env
  afterOperationsProtected?: () => void | Promise<void>
  afterCanonicalFinalization?: () => void | Promise<void>
}): Promise<void> {
  const operation = await getArtifactIntakeOperation(args.env, args.job.tenantId, args.prepared.uploadId)
  if (!operation || (operation.status !== 'sealed' && operation.status !== 'finalized')) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  await renewChannelMediaLease(args.job.tenantId, args.job.id, args.leaseToken, args.env)
  const providerLabel = args.job.provider === 'telegram' ? 'Telegram' : 'Sendblue'
  const receipt = await finalizeArtifactCapture({
    tenantId: args.job.tenantId,
    content: channelMediaSearchableBody(args.descriptor, args.prepared.description),
    title: `${providerLabel} photo`, scope: 'general',
    provenance: `${args.job.provider}_photo`, clientName: providerLabel,
    agentIdentity: `${args.job.provider}-provider`,
    sourceRef: `${args.job.provider}:operation:${args.job.id}`,
    idempotencyKey: `channel-media-finalize:${args.job.id}`,
    sourceSystem: args.job.provider, authorKind: 'user',
    artifacts: [{
      uploadId: args.prepared.uploadId, role: 'source', primary: true,
      detectedMimeType: args.prepared.detectedMimeType,
      declaredMimeType: args.prepared.declaredMimeType,
      byteLength: args.prepared.byteLength,
      plaintextSha256: args.prepared.plaintextSha256,
    }],
    declaredDerivativeUploadIds: [],
  }, args.tmk, args.env, {
    beforeCanonicalSideEffects: () => renewChannelMediaLease(
      args.job.tenantId, args.job.id, args.leaseToken, args.env,
    ),
    afterOperationsProtected: args.afterOperationsProtected,
  })
  await args.afterCanonicalFinalization?.()
  const verified = await getArtifactIntakeStatus({
    tenantId: args.job.tenantId, uploadId: args.prepared.uploadId,
  }, args.env)
  if (
    verified.status !== 'finalized' || verified.canonicalCaptureId !== receipt.captureId ||
    verified.canonicalDocumentId !== receipt.documentId || receipt.artifacts.length !== 1 ||
    receipt.artifacts[0]?.role !== 'source' || !receipt.artifacts[0]?.primary
  ) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  await renewChannelMediaLease(args.job.tenantId, args.job.id, args.leaseToken, args.env)
  await markChannelMediaFinalized({
    tenantId: args.job.tenantId, operationId: args.job.id, uploadId: args.prepared.uploadId,
    captureId: receipt.captureId, documentId: receipt.documentId,
    canonicalOperationId: receipt.operationId, leaseToken: args.leaseToken,
  }, args.env)
}
