// Sendblue inbound processing (mission Phase 4).
// Text: memory-grounded reply via the retrieval broker + canonical capture
// through the ingestion queue (TMK lives in the DO, not the webhook).
// Photo: media -> R2 raw artifact -> vision description -> queued capture.
// Law 2: no message content or media in logs; AI calls via gateway with
// collectLog:false; captures encrypt through the standard retain path.

import type { Env } from '../types/env'
import type { IngestionQueueMessage } from '../types/ingestion'
import { searchCanonicalMemory } from './canonical-memory-query'
import { sendSendblueMessage } from './delivery/sendblue'
import { runGatewayChat, runGatewayVision } from './workers-ai-chat'

export interface SendblueInboundBody {
  content?: string
  media_url?: string
  is_outbound?: boolean
  from_number?: string
  to_number?: string
  number?: string
  date_sent?: string
}

export async function resolveSendblueTenant(fromNumber: string, env: Env): Promise<string | null> {
  const row = await env.D1_US.prepare(
    'SELECT tenant_id FROM tenant_phone_numbers WHERE phone_e164 = ?',
  ).bind(fromNumber).first<{ tenant_id: string }>()
  return row?.tenant_id ?? null
}

/** Memory-grounded reply: broker context assembled into one cheap-tier call. */
export async function generateGroundedReply(
  env: Env,
  tenantId: string,
  text: string,
): Promise<string> {
  let contextBlock = ''
  try {
    const context = await searchCanonicalMemory(
      { tenantId, query: text, mode: 'composed', limit: 5 }, env, tenantId,
    )
    if (context.items.length > 0) {
      contextBlock = '\n\nRelevant memories (cite naturally when useful):\n' + context.items
        .map((item) => `- [${item.sourceSystem ?? 'memory'}${item.capturedAt ? ', ' + new Date(item.capturedAt).toISOString().slice(0, 10) : ''}] ${item.preview}`)
        .join('\n')
    }
  } catch {
    // Retrieval issues never block a reply.
  }
  const reply = await runGatewayChat(env, [
    {
      role: 'system',
      content: 'You are Haetsal, a warm and capable personal AI assistant reached over iMessage. Keep replies concise and conversational. Ground answers in the provided memories when relevant; if a needed source (like Gmail or calendar) is not connected yet, say so honestly.' + contextBlock,
    },
    { role: 'user', content: text },
  ])
  return reply ?? 'I had trouble thinking just now - try me again in a moment.'
}

async function describePhoto(env: Env, imageBytes: ArrayBuffer, mediaType: string): Promise<string> {
  const description = await runGatewayVision(
    env,
    'Describe this image concisely and concretely for a personal memory archive: subjects, any legible text, and context. 2-4 sentences.',
    imageBytes,
    mediaType,
  )
  return description ?? 'Photo captured (no description available).'
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
    console.warn('SENDBLUE_UNKNOWN_SENDER', { suffix: body.from_number.slice(-4) })
    return { handled: false, kind: 'ignored' }
  }
  const occurredAt = body.date_sent ? Date.parse(body.date_sent) || Date.now() : Date.now()

  if (body.media_url) {
    const media = await fetch(body.media_url)
    if (!media.ok) throw new Error(`Sendblue media fetch failed: ${media.status}`)
    const mediaType = media.headers.get('content-type') ?? 'image/jpeg'
    const bytes = await media.arrayBuffer()
    const storageKey = `sendblue-media/${tenantId}/${occurredAt}-${crypto.randomUUID()}`
    await env.R2_ARTIFACTS.put(storageKey, bytes, { httpMetadata: { contentType: mediaType } })
    const description = await describePhoto(env, bytes, mediaType)

    const message: IngestionQueueMessage = {
      type: 'sendblue_media',
      tenantId,
      payload: {
        from: body.from_number,
        description,
        caption: body.content ?? null,
        storageKey,
        mediaType,
        byteLength: bytes.byteLength,
        occurredAt,
      },
      enqueuedAt: Date.now(),
    }
    ctx.waitUntil(env.QUEUE_HIGH.send(message))
    ctx.waitUntil(sendSendblueMessage(
      body.from_number,
      `Captured that photo: ${description}`,
      env,
    ).then(() => undefined))
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

  const reply = await generateGroundedReply(env, tenantId, text)
  const sent = await sendSendblueMessage(body.from_number, reply, env)
  if (!sent.success) {
    console.warn('SENDBLUE_REPLY_NOT_DELIVERED', { status: sent.status, errorCode: sent.errorCode ?? null })
  }
  return { handled: true, kind: 'text' }
}
