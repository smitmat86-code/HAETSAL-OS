import type { CanonicalArtifactRef, CanonicalCaptureGovernanceInput, CanonicalCaptureResult } from './canonical-memory'

export type IngestionSource =
  | 'sms'
  | 'sendblue'
  | 'telegram'
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'obsidian'
  | 'file'
  | 'mcp_retain'
  | 'ops_alert'
  | 'mcp:memory_write'
  | 'cron:consolidation'
  | 'cron:dream'
  | `agent:${string}`
  | `session:${string}`

export interface IngestionArtifact {
  tenantId: string
  source: IngestionSource
  sourceRef?: string | null
  content: string
  occurredAt: number
  memoryType?: 'episodic' | 'semantic' | 'world'
  domain?: string
  provenance?: string
  artifactRef?: CanonicalArtifactRef | null
  metadata?: Record<string, unknown>
  /** Provenance envelope + governance overrides for the canonical write (Phase 1). */
  governance?: CanonicalCaptureGovernanceInput | null
}

export interface SalienceResult {
  tier: 1 | 2 | 3
  surpriseScore: number
  queue: 'QUEUE_HIGH' | 'QUEUE_NORMAL'
  reasons: string[]
}

export interface RetainResult {
  memoryId: string
  operationId?: string | null
  documentId?: string | null
  salienceTier: number
  dedupHash: string
  canonicalCaptureId?: string | null
  canonicalDocumentId?: string | null
  canonicalOperationId?: string | null
  canonicalDispatchStatus?: 'queued' | 'failed'
  governance?: CanonicalCaptureResult['governance']
}

export type IngestionQueueMessageType =
  | 'canonical_projection_dispatch'
  | 'retain_artifact'
  | 'ops_alert_memory'
  | 'chat_inbound'
  | 'channel_media'
  | 'sms_inbound'
  | 'gmail_thread'
  | 'calendar_event'
  | 'obsidian_note'
  | 'bootstrap_gmail_thread'
  | 'bootstrap_calendar_event'
  | 'bootstrap_drive_file'

/** 14.3 queue-side chat: one durable reply job per inbound message. Carries
 *  plaintext text in queue transit only — same accepted pattern as
 *  sms_inbound (ops runbook ADR #3). */
export interface ChatInboundPayload {
  channel: 'telegram'
  chatId: number
  text: string
  occurredAt: number
  /** Telegram update_id — idempotence marker so a retry never double-replies. */
  updateId?: number
}

export interface QueuedRetainPayload {
  requestId: string
  artifact: Omit<IngestionArtifact, 'tenantId'>
  contentEncrypted?: string
}

export interface IngestionQueueMessage {
  type: IngestionQueueMessageType
  tenantId: string
  payload: Record<string, unknown>
  enqueuedAt: number
}
