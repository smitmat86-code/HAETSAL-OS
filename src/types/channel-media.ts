export type ChannelMediaProvider = 'telegram' | 'sendblue'
export type ChannelMediaJobStatus =
  | 'accepted' | 'processing' | 'retryable' | 'finalized'
  | 'delivered' | 'failed' | 'delivery_unknown'
export type ChannelMediaDeliveryStatus = 'pending' | 'claimed' | 'delivered' | 'failed' | 'unknown'
/**
 * Artifact integrity is recorded separately from delivery truth: an incident
 * never rewrites finalized capture or provider delivery history.
 */
export type ChannelMediaIntegrityStatus = 'artifact_integrity_incident' | null

export interface ChannelMediaDescriptor {
  version: 1
  provider: ChannelMediaProvider
  locatorKind: 'telegram_file_id' | 'sendblue_message_handle' | 'sendblue_temporary_url'
  locator: string
  replyTarget: string
  caption: string | null
  occurredAt: number
}

export interface ChannelMediaJob {
  id: string
  tenantId: string
  provider: ChannelMediaProvider
  status: ChannelMediaJobStatus
  errorCode: string | null
  attemptCount: number
  leaseToken: string | null
  leaseExpiresAt: number | null
  deliveryStatus: ChannelMediaDeliveryStatus
  integrityStatus: ChannelMediaIntegrityStatus
  handoffStatus: 'pending' | 'deleted'
  artifactUploadId: string | null
  canonicalCaptureId: string | null
  canonicalDocumentId: string | null
  canonicalOperationId: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface AcquiredChannelMedia {
  bytes: Uint8Array
  detectedMimeType: string
  declaredMimeType?: string
}

export interface PreparedChannelMediaCapture {
  version: 1
  uploadId: string
  description: string
  detectedMimeType: string
  declaredMimeType?: string
  byteLength: number
  plaintextSha256: string
}
