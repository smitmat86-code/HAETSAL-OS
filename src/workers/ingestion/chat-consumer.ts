// src/workers/ingestion/chat-consumer.ts
// 14.3 queue-side chat: the durable reply job. The webhook only enqueues;
// this consumer runs the pipeline (automation intent → delegation → grounded
// reply with session context), sends the reply, then does best-effort
// bookkeeping. Ordering is the idempotence story:
//   throw BEFORE the send → the message retries (bounded, then DLQ) with no
//   user-visible side effect; AFTER a successful send nothing throws, and a
//   KV marker on the Telegram update_id makes redeliveries reply-free.
// Needs no TMK: retrieval reads canonical via the broker, delivery is a bot
// call — so it runs before the consumer's key block.

import type { Env } from '../../types/env'
import type { ChatInboundPayload } from '../../types/ingestion'
import { sendTelegramReply } from '../../services/delivery/telegram'
import { buildGroundedReply } from '../../services/messaging-helpers'
import { maybeDelegateExecutionTask } from '../../services/agents/delegation'
import { maybeHandleAutomationChat } from '../../services/agents/automation-chat'
import { fetchSessionBlock, recordSessionExchange } from '../../services/session/client'

const REPLY_MARKER_TTL_SECONDS = 24 * 60 * 60

function replyMarkerKey(tenantId: string, updateId: number): string {
  return `tg_replied:${tenantId}:${updateId}`
}

export async function processChatInbound(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const chat = payload as unknown as ChatInboundPayload
  if (chat.channel !== 'telegram' || typeof chat.chatId !== 'number' || !chat.text) return

  if (typeof chat.updateId === 'number') {
    const already = await env.KV_SESSION.get(replyMarkerKey(tenantId, chat.updateId)).catch(() => null)
    if (already) return
  }

  const route = { channel: 'telegram' as const, replyTo: String(chat.chatId) }
  const sessionKey = `telegram:${chat.chatId}`
  const reply = await maybeHandleAutomationChat(env, tenantId, chat.text, route)
    ?? await maybeDelegateExecutionTask(env, tenantId, chat.text, route)
    ?? await buildGroundedReply(env, tenantId, chat.text, 'Telegram',
      await fetchSessionBlock(env, tenantId, sessionKey))

  const sent = await sendTelegramReply(chat.chatId, reply, env)
  if (!sent) throw new Error('TelegramSendFailed') // pre-send failure → safe retry

  // Post-send: never throw (a retry now would double-reply).
  if (typeof chat.updateId === 'number') {
    await env.KV_SESSION.put(replyMarkerKey(tenantId, chat.updateId), '1', {
      expirationTtl: REPLY_MARKER_TTL_SECONDS,
    }).catch((error: unknown) => {
      console.warn('CHAT_REPLY_MARKER_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  try {
    recordSessionExchange(env, tenantId, sessionKey, chat.text, reply, ctx)
  } catch (error) {
    console.warn('CHAT_SESSION_RECORD_FAILED', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
