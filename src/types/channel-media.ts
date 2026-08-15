export type ChannelMediaProvider = 'telegram' | 'sendblue'
export type ChannelMediaJobStatus =
  | 'accepted' | 'processing' | 'retryable' | 'finalized'
  | 'delivered' | 'failed' | 'delivery_unknown'
export type ChannelMediaDeliveryStatus = 'pending' | 'claimed' | 'delivered' | 'failed' | 'unknown'

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
  leaseExpiresAt: number | null
  deliveryStatus: ChannelMediaDeliveryStatus
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
