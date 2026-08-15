import type { Env } from '../../types/env'
import type { AcquiredChannelMedia, ChannelMediaDescriptor, ChannelMediaJob } from '../../types/channel-media'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sha256Bytes } from '../artifact-intake/crypto'
import { finalizeArtifactCapture } from '../artifact-intake/finalize'
import { getArtifactIntakeStatus, reserveArtifactUpload, uploadArtifactBytes } from '../artifact-intake/operations'
import { markChannelMediaFinalized } from './jobs'

export function channelMediaSearchableBody(
  descriptor: ChannelMediaDescriptor,
  description: string,
): string {
  return descriptor.caption
    ? `${descriptor.caption}\n\nPhoto: ${description}`
    : `Photo: ${description}`
}

export async function finalizeChannelMediaJob(args: {
  job: ChannelMediaJob
  descriptor: ChannelMediaDescriptor
  acquired: AcquiredChannelMedia
  description: string
  tmk: CryptoKey
  env: Env
}): Promise<void> {
  const plaintextSha256 = await sha256Bytes(args.acquired.bytes)
  const upload = await reserveArtifactUpload({
    tenantId: args.job.tenantId,
    idempotencyKey: `channel-media-upload:${args.job.id}`,
    byteLength: args.acquired.bytes.byteLength,
    plaintextSha256,
    declaredMimeType: args.acquired.declaredMimeType,
  }, args.env)
  await uploadArtifactBytes({
    tenantId: args.job.tenantId, uploadId: upload.uploadId,
    bytes: args.acquired.bytes, detectedMimeType: args.acquired.detectedMimeType,
    declaredMimeType: args.acquired.declaredMimeType,
    encryptionFamily: 'tmk', key: args.tmk,
  }, args.env)
  const providerLabel = args.job.provider === 'telegram' ? 'Telegram' : 'Sendblue'
  const receipt = await finalizeArtifactCapture({
    tenantId: args.job.tenantId,
    content: channelMediaSearchableBody(args.descriptor, args.description),
    title: `${providerLabel} photo`, scope: 'general',
    provenance: `${args.job.provider}_photo`, clientName: providerLabel,
    agentIdentity: `${args.job.provider}-provider`,
    sourceRef: `${args.job.provider}:operation:${args.job.id}`,
    idempotencyKey: `channel-media-finalize:${args.job.id}`,
    sourceSystem: args.job.provider, authorKind: 'user',
    artifacts: [{
      uploadId: upload.uploadId, role: 'source', primary: true,
      detectedMimeType: args.acquired.detectedMimeType,
      declaredMimeType: args.acquired.declaredMimeType,
      byteLength: args.acquired.bytes.byteLength, plaintextSha256,
    }],
    declaredDerivativeUploadIds: [],
  }, args.tmk, args.env)
  const verified = await getArtifactIntakeStatus({
    tenantId: args.job.tenantId, uploadId: upload.uploadId,
  }, args.env)
  if (
    verified.status !== 'finalized' || verified.canonicalCaptureId !== receipt.captureId ||
    verified.canonicalDocumentId !== receipt.documentId || receipt.artifacts.length !== 1 ||
    receipt.artifacts[0]?.role !== 'source' || !receipt.artifacts[0]?.primary
  ) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  await markChannelMediaFinalized({
    tenantId: args.job.tenantId, operationId: args.job.id, uploadId: upload.uploadId,
    captureId: receipt.captureId, documentId: receipt.documentId,
    canonicalOperationId: receipt.operationId,
  }, args.env)
}
