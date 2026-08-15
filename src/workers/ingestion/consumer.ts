// src/workers/ingestion/consumer.ts
// Queue consumer for ingestion queues (QUEUE_HIGH, QUEUE_NORMAL, QUEUE_BULK)
// Dispatches by message type to handler to retainContent()
// LESSON: Promise.allSettled for fan-out, INSERT OR IGNORE for at-least-once
// LESSON: Cold DO (getTmk null) re-enqueues with delay, not dropped

import type { Env } from '../../types/env'
import type { IngestionQueueMessage } from '../../types/ingestion'
import { getMcpAgentObjectId } from '../mcpagent/do/identity'
import { processCanonicalProjectionDispatch } from './canonical-projection-consumer'
import { processQueuedRetainArtifact } from './retain-consumer'
import { processOpsAlertMemory } from './ops-alert-memory-consumer'
import { processChatInbound } from './chat-consumer'
import { processChannelMediaJob } from '../../services/channel-media/orchestrator'
import { fetchAndValidateKek } from '../../cron/kek'
import { ArtifactIntakeContractError } from '../../services/artifact-intake/contracts'
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
 * Handle a batch of ingestion queue messages.
 * Dispatches by message type to the appropriate handler.
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

  if (type === 'canonical_projection_dispatch') {
    await processCanonicalProjectionDispatch(tenantId, payload, env, ctx)
    msg.ack()
    return
  }

  // 14.3: chat reply job has no TMK dependency; bounded retry sends transient
  // gateway storms to DLQ rather than eating the reply.
  if (type === 'chat_inbound') {
    try {
      await processChatInbound(tenantId, payload, env, ctx)
      msg.ack()
    } catch (error) {
      console.warn('CHAT_INBOUND_RETRY', {
        tenantId,
        messageId: msg.id,
        error: error instanceof Error ? error.message : String(error),
      })
      msg.retry({ delaySeconds: 15 })
    }
    return
  }

  // M4: ops-alert memories encrypt with the Cron KEK consumer-side (no TMK
  // exists on the unauthenticated webhook path); handler acks/retries itself.
  if (type === 'ops_alert_memory') {
    await processOpsAlertMemory(msg as never, env, ctx)
    return
  }

  if (type === 'retain_artifact') {
    console.log('INGESTION_RETAIN_ARTIFACT_START', { tenantId, requestId: payload.requestId })
    await processQueuedRetainArtifact(tenantId, payload, env, ctx)
    console.log('INGESTION_RETAIN_ARTIFACT_DONE', { tenantId, requestId: payload.requestId })
    msg.ack()
    return
  }

  // Queue handlers below require the tenant memory key (TMK): Google OAuth
  // tokens and retained canonical bodies are encrypted with it. The Cron KEK is
  // a separate random key and is not interchangeable, so cold/uninitialized DO
  // state must retry instead of silently decrypting/encrypting with the wrong key.
  const doId = getMcpAgentObjectId(env.MCPAGENT, tenantId)
  const stub = env.MCPAGENT.get(doId)

  let tmk: CryptoKey | null = null
  try {
    tmk = await stub.getTmk()
  } catch {
    tmk = null
  }

  if (!tmk) {
    console.warn('INGESTION_RETRY_WAITING_FOR_TMK', { tenantId, type, messageId: msg.id })
    msg.retry({ delaySeconds: 30 })
    return
  }

  if (type === 'channel_media') {
    const operationId = typeof payload.operationId === 'string' ? payload.operationId : ''
    try {
      const kek = await fetchAndValidateKek(tenantId, env)
      if (!kek) {
        console.warn('CHANNEL_MEDIA_WAITING_FOR_KEY')
        msg.retry({ delaySeconds: 30 })
        return
      }
      await processChannelMediaJob({ tenantId, operationId, tmk, kek, env })
      msg.ack()
    } catch (error) {
      const code = error instanceof ArtifactIntakeContractError ? error.code : 'invalid_state'
      console.warn('CHANNEL_MEDIA_JOB_RETRY', { code })
      msg.retry({ delaySeconds: 30 })
    }
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
