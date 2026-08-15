// Sendblue inbound processing (mission Phase 4).
// Text: memory-grounded reply via the retrieval broker + canonical capture
// through the ingestion queue (TMK lives in the DO, not the webhook).
// Photo: durable governed operation -> opaque queue locator -> shared intake.
// Law 2: no message content or media in logs; AI calls via gateway with
// collectLog:false; captures encrypt through the standard retain path.

import type { Env } from '../types/env'
import type { IngestionQueueMessage } from '../types/ingestion'
import { sendSendblueMessage } from './delivery/sendblue'
import { buildGroundedReply } from './messaging-helpers'
import { acceptChannelMedia } from './channel-media/intake'
import { maybeDelegateExecutionTask } from './agents/delegation'
import { maybeHandleAutomationChat } from './agents/automation-chat'
import { fetchSessionBlock, recordSessionExchange } from './session/client'

export interface SendblueInboundBody {
  content?: string
  media_url?: string
  is_outbound?: boolean
  from_number?: string
  to_number?: string
  number?: string
  date_sent?: string
  message_handle?: string
}

export async function resolveSendblueTenant(fromNumber: string, env: Env): Promise<string | null> {
  const row = await env.D1_US.prepare(
    'SELECT tenant_id FROM tenant_phone_numbers WHERE phone_e164 = ?',
  ).bind(fromNumber).first<{ tenant_id: string }>()
  return row?.tenant_id ?? null
}

export async function processSendblueInbound(
  body: SendblueInboundBody,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<{ handled: boolean; kind: 'text' | 'media' | 'ignored' }> {
  if (body.is_outbound || !body.from_number) return { handled: false, kind: 'ignored' }
  const tenantId = await resolveSendblueTenant(body.from_number, env)
  if (!tenantId) {
    // Shared line: unknown senders are never trusted or replied to.
    console.warn('SENDBLUE_UNKNOWN_SENDER')
    return { handled: false, kind: 'ignored' }
  }
  const occurredAt = body.date_sent ? Date.parse(body.date_sent) || Date.now() : Date.now()

  if (body.media_url) {
    const stableHandle = body.message_handle?.trim()
    const eventIdentity = stableHandle
      ? `message:${stableHandle}`
      : `fallback:${body.date_sent ?? occurredAt}:${body.media_url}`
    await acceptChannelMedia({
      tenantId,
      provider: 'sendblue',
      eventIdentity,
      descriptor: {
        version: 1,
        provider: 'sendblue',
        locatorKind: stableHandle ? 'sendblue_message_handle' : 'sendblue_temporary_url',
        locator: stableHandle ?? body.media_url,
        replyTarget: body.from_number,
        caption: body.content ?? null,
        occurredAt,
      },
    }, env)
    return { handled: true, kind: 'media' }
  }

  const text = body.content?.trim()
  if (!text) return { handled: false, kind: 'ignored' }

  const message: IngestionQueueMessage = {
    type: 'sms_inbound',
    tenantId,
    payload: { from: body.from_number, text, occurredAt, channel: 'sendblue' },
    enqueuedAt: Date.now(),
  }
  ctx.waitUntil(env.QUEUE_HIGH.send(message))

  // Phase 7: automation intent/commands first; Phase 6: multi-step asks spawn
  // a scoped execution agent; everything else gets the grounded reply with
  // the Phase 9 working-session window as conversation context.
  const route = { channel: 'sendblue' as const, replyTo: body.from_number }
  const sessionKey = `sendblue:${body.from_number}`
  const reply = await maybeHandleAutomationChat(env, tenantId, text, route)
    ?? await maybeDelegateExecutionTask(env, tenantId, text, route)
    ?? await buildGroundedReply(env, tenantId, text, 'iMessage',
      await fetchSessionBlock(env, tenantId, sessionKey))
  recordSessionExchange(env, tenantId, sessionKey, text, reply, ctx)
  const sent = await sendSendblueMessage(body.from_number, reply, env)
  if (!sent.success) {
    console.warn('SENDBLUE_REPLY_NOT_DELIVERED', { status: sent.status })
  }
  return { handled: true, kind: 'text' }
}
