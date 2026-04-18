// src/workers/ingestion/consumer.ts
// Queue consumer for ingestion queues (QUEUE_HIGH, QUEUE_NORMAL, QUEUE_BULK)
// Dispatches by message type → handler → retainContent()
// LESSON: Promise.allSettled for fan-out, INSERT OR IGNORE for at-least-once
// LESSON: Cold DO (getTmk null) → re-enqueue with delay, not dropped

import type { Env } from '../../types/env'
import type { IngestionQueueMessage } from '../../types/ingestion'
import { getMcpAgentObjectId } from '../mcpagent/do/identity'
import { processQueuedRetainArtifact } from './retain-consumer'
import {
  handleSmsInbound,
  handleGmailThread,
  handleCalendarEvent,
  handleObsidianNote,
  handleBootstrapGmailThread,
  handleBootstrapCalendarEvent,
  handleBootstrapDriveFile,
} from './handlers'

/**
 * Handle a batch of ingestion queue messages
 * Dispatches by message type to appropriate handler
 */
export async function handleIngestionBatch(
  batch: MessageBatch<IngestionQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const results = await Promise.allSettled(
    batch.messages.map(async (msg) => {
      await processIngestionMessage(msg, env, ctx)
      return msg.id
    }),
  )
  const failures = results.filter(r => r.status === 'rejected')
  for (const failure of failures) {
    console.error('INGESTION_BATCH_MESSAGE_FAILED', failure.reason)
  }
  if (failures.length > 0 && failures.length === batch.messages.length) {
    throw new Error(`All ${failures.length} ingestion messages failed`)
  }
}

async function processIngestionMessage(
  msg: Message<IngestionQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { type, tenantId, payload } = msg.body

  if (type === 'retain_artifact') {
    console.log('INGESTION_RETAIN_ARTIFACT_START', { tenantId, requestId: payload.requestId })
    await processQueuedRetainArtifact(tenantId, payload, env, ctx)
    console.log('INGESTION_RETAIN_ARTIFACT_DONE', { tenantId, requestId: payload.requestId })
    msg.ack()
    return
  }

  // Get TMK from DO — if cold (null), re-enqueue with delay
  const doId = getMcpAgentObjectId(env.MCPAGENT, tenantId)
  const stub = env.MCPAGENT.get(doId)

  let tmk: CryptoKey | null = null
  try {
    // @ts-expect-error -- DO RPC method not in generic DurableObjectStub type
    tmk = await stub.getTmk()
  } catch {
    tmk = null
  }

  if (!tmk) {
    // Cold DO — re-enqueue with 30s delay
    // Cannot process without TMK for encryption (Law 2)
    console.warn('INGESTION_RETRY_WAITING_FOR_TMK', { tenantId, type, messageId: msg.id })
    msg.retry({ delaySeconds: 30 })
    return
  }

  switch (type) {
    case 'sms_inbound':
      await handleSmsInbound(tenantId, payload, tmk, env, ctx)
      break
    case 'gmail_thread':
      await handleGmailThread(tenantId, payload, tmk, env, ctx)
      break
    case 'calendar_event':
      await handleCalendarEvent(tenantId, payload, tmk, env, ctx)
      break
    case 'obsidian_note':
      await handleObsidianNote(tenantId, payload, tmk, env, ctx)
      break
    case 'bootstrap_gmail_thread':
      await handleBootstrapGmailThread(tenantId, payload, tmk, env, ctx)
      break
    case 'bootstrap_calendar_event':
      await handleBootstrapCalendarEvent(tenantId, payload, tmk, env, ctx)
      break
    case 'bootstrap_drive_file':
      await handleBootstrapDriveFile(tenantId, payload, tmk, env, ctx)
      break
    default:
      break
  }

  msg.ack()
}
