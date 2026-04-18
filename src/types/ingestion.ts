// src/types/ingestion.ts
// Ingestion pipeline types — used by all ingest sources (SMS, Gmail, Calendar, Obsidian, file, MCP retain)

export type IngestionSource =
  | 'sms'
  | 'gmail'
  | 'calendar'
  | 'obsidian'
  | 'file'
  | 'mcp_retain'
  | 'mcp:memory_write'
  | 'cron:consolidation'
  | `agent:${string}`

export interface IngestionArtifact {
  tenantId: string
  source: IngestionSource
  content: string
  occurredAt: number       // unix ms — when the event originally happened
  memoryType?: 'episodic' | 'semantic' | 'world'
  domain?: string
  provenance?: string      // 'sms' | 'email' | 'obsidian' | 'user_authored' | etc.
  metadata?: Record<string, unknown>
}

export interface SalienceResult {
  tier: 1 | 2 | 3
  surpriseScore: number    // 0.0–1.0 (stub: 0.5 until Phase 3)
  queue: 'QUEUE_HIGH' | 'QUEUE_NORMAL'
  reasons: string[]
}

export interface RetainResult {
  memoryId: string         // Stable retained document reference or operation id
  operationId?: string | null
  documentId?: string | null
  salienceTier: number
  dedupHash: string
  stoneR2Key: string | null
}

export type IngestionQueueMessageType =
  | 'retain_artifact'
  | 'sms_inbound'
  | 'gmail_thread'
  | 'calendar_event'
  | 'obsidian_note'
  | 'bootstrap_gmail_thread'
  | 'bootstrap_calendar_event'
  | 'bootstrap_drive_file'

export interface QueuedRetainPayload {
  requestId: string
  artifact: Omit<IngestionArtifact, 'tenantId'>
  contentEncrypted?: string
}

export interface IngestionQueueMessage {
  type: IngestionQueueMessageType
  tenantId: string
  payload: Record<string, unknown>
  enqueuedAt: number       // unix ms
}
