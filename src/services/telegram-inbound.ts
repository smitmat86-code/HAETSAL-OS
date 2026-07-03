// Telegram inbound processing (mission Phase 4.1).
// Same shape as sendblue-inbound.ts: text -> grounded reply + queued canonical
// capture; photo -> R2 raw artifact + vision description + queued capture with
// artifactRef. Tenant routing is chat.id -> tenant via telegram_chats D1 table
// (mirror of tenant_phone_numbers). Delivery is direct chat_id, not KV lookup.

import type { Env } from '../types/env'
import type { IngestionQueueMessage } from '../types/ingestion'
import { sendTelegramReply } from './delivery/telegram'
import { buildGroundedReply, describeInboundPhoto } from './messaging-helpers'

export interface TelegramPhotoSize { file_id: string; width?: number; height?: number; file_size?: number }
export interface TelegramMessage {
  chat?: { id?: number }
  text?: string
  caption?: string
  date?: number
  photo?: TelegramPhotoSize[]
  from?: { id?: number; is_bot?: boolean }
}
export interface TelegramUpdate { message?: TelegramMessage }

export async function resolveTelegramTenant(chatId: number, env: Env): Promise<string | null> {
  const row = await env.D1_US.prepare(
    'SELECT tenant_id FROM telegram_chats WHERE chat_id = ?',
  ).bind(chatId).first<{ tenant_id: string }>()
  return row?.tenant_id ?? null
}

/** Given a Telegram file_id, fetch the raw bytes via the Bot File API. */
async function fetchTelegramFile(fileId: string, env: Env): Promise<{ bytes: ArrayBuffer; mediaType: string } | null> {
  const meta = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`)
  if (!meta.ok) return null
  const parsed = await meta.json() as { ok?: boolean; result?: { file_path?: string } }
  const path = parsed?.result?.file_path
  if (!path) return null
  const file = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`)
  if (!file.ok) return null
  return { bytes: await file.arrayBuffer(), mediaType: file.headers.get('content-type') ?? 'image/jpeg' }
}

export async function processTelegramInbound(
  update: TelegramUpdate,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<{ handled: boolean; kind: 'text' | 'media' | 'ignored' | 'command' }> {
  const msg = update.message
  const chatId = msg?.chat?.id
  if (!msg || typeof chatId !== 'number' || msg.from?.is_bot) return { handled: false, kind: 'ignored' }
  const tenantId = await resolveTelegramTenant(chatId, env)
  if (!tenantId) {
    console.warn('TELEGRAM_UNKNOWN_CHAT', { suffix: String(chatId).slice(-4) })
    return { handled: false, kind: 'ignored' }
  }
  const occurredAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) => ((a.file_size ?? 0) > (b.file_size ?? 0) ? a : b))
    const file = await fetchTelegramFile(largest.file_id, env)
    if (!file) return { handled: false, kind: 'ignored' }
    const storageKey = `telegram-media/${tenantId}/${occurredAt}-${crypto.randomUUID()}`
    await env.R2_ARTIFACTS.put(storageKey, file.bytes, { httpMetadata: { contentType: file.mediaType } })
    const description = await describeInboundPhoto(env, file.bytes, file.mediaType)

    const message: IngestionQueueMessage = {
      type: 'telegram_media', tenantId,
      payload: {
        chatId, description, caption: msg.caption ?? null, storageKey,
        mediaType: file.mediaType, byteLength: file.bytes.byteLength, occurredAt,
      },
      enqueuedAt: Date.now(),
    }
    ctx.waitUntil(env.QUEUE_HIGH.send(message))
    ctx.waitUntil(sendTelegramReply(chatId, `Captured that photo: ${description}`, env).then(() => undefined))
    return { handled: true, kind: 'media' }
  }

  const text = msg.text?.trim()
  if (!text || text.startsWith('/')) return { handled: false, kind: 'command' }

  const message: IngestionQueueMessage = {
    type: 'sms_inbound', tenantId,
    payload: { from: String(chatId), text, occurredAt, channel: 'telegram' },
    enqueuedAt: Date.now(),
  }
  ctx.waitUntil(env.QUEUE_HIGH.send(message))

  const reply = await buildGroundedReply(env, tenantId, text, 'Telegram')
  const sent = await sendTelegramReply(chatId, reply, env)
  if (!sent) console.warn('TELEGRAM_REPLY_NOT_DELIVERED', { suffix: String(chatId).slice(-4) })
  return { handled: true, kind: 'text' }
}
