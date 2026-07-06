// Telegram inbound processing (mission Phase 4.1; queue-side since 14.3).
// Text -> TWO durable jobs enqueued before the webhook acks: sms_inbound
// (canonical capture, unchanged) + chat_inbound (the reply pipeline runs in
// the queue consumer — src/workers/ingestion/chat-consumer.ts). Photo -> the
// heavy leg (file fetch, R2, vision) detaches via waitUntil so the ack stays
// fast. Tenant routing is chat.id -> tenant via telegram_chats D1 table.

import type { Env } from '../types/env'
import type { ChatInboundPayload, IngestionQueueMessage } from '../types/ingestion'
import { sendTelegramReply } from './delivery/telegram'
import { describeInboundPhoto } from './messaging-helpers'

export interface TelegramPhotoSize { file_id: string; width?: number; height?: number; file_size?: number }
export interface TelegramMessage {
  chat?: { id?: number }
  text?: string
  caption?: string
  date?: number
  photo?: TelegramPhotoSize[]
  from?: { id?: number; is_bot?: boolean }
}
export interface TelegramUpdate { update_id?: number; message?: TelegramMessage }

let schemaEnsured = false
export async function ensureTelegramSchema(env: Env): Promise<void> {
  if (schemaEnsured) return
  await env.D1_US.batch([
    env.D1_US.prepare(
      `CREATE TABLE IF NOT EXISTS telegram_chats (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
         chat_id INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL)`,
    ),
    env.D1_US.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_chat_id ON telegram_chats(chat_id)'),
    env.D1_US.prepare('CREATE INDEX IF NOT EXISTS idx_telegram_chat_tenant ON telegram_chats(tenant_id)'),
  ])
  schemaEnsured = true
}

export async function resolveTelegramTenant(chatId: number, env: Env): Promise<string | null> {
  await ensureTelegramSchema(env)
  const row = await env.D1_US.prepare(
    'SELECT tenant_id FROM telegram_chats WHERE chat_id = ?',
  ).bind(chatId).first<{ tenant_id: string }>()
  return row?.tenant_id ?? null
}

/** Infer an image mime from a Telegram file_path extension; the Bot File API
 *  serves photos with content-type: application/octet-stream, which the
 *  vision model rejects — trust the extension instead. */
function mediaTypeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'heic') return 'image/heic'
  return 'image/jpeg'
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
  const headerType = file.headers.get('content-type')
  const mediaType = headerType?.startsWith('image/') ? headerType : mediaTypeFromPath(path)
  return { bytes: await file.arrayBuffer(), mediaType }
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
    console.warn('TELEGRAM_UNKNOWN_CHAT', { chatId })
    return { handled: false, kind: 'ignored' }
  }
  const occurredAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photos = msg.photo
    const caption = msg.caption ?? null
    ctx.waitUntil((async () => {
      const largest = photos.reduce((a, b) => ((a.file_size ?? 0) > (b.file_size ?? 0) ? a : b))
      const file = await fetchTelegramFile(largest.file_id, env)
      if (!file) return
      const storageKey = `telegram-media/${tenantId}/${occurredAt}-${crypto.randomUUID()}`
      await env.R2_ARTIFACTS.put(storageKey, file.bytes, { httpMetadata: { contentType: file.mediaType } })
      const description = await describeInboundPhoto(env, file.bytes, file.mediaType)
      const message: IngestionQueueMessage = {
        type: 'telegram_media', tenantId,
        payload: {
          chatId, description, caption, storageKey,
          mediaType: file.mediaType, byteLength: file.bytes.byteLength, occurredAt,
        },
        enqueuedAt: Date.now(),
      }
      await env.QUEUE_HIGH.send(message)
      await sendTelegramReply(chatId, `Captured that photo: ${description}`, env)
    })().catch((error: unknown) => {
      console.error('TELEGRAM_PHOTO_PIPELINE_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      })
    }))
    return { handled: true, kind: 'media' }
  }

  const text = msg.text?.trim()
  if (!text || text.startsWith('/')) return { handled: false, kind: 'command' }

  // 14.3: enqueue-only — capture job + reply job are BOTH durable before the
  // webhook acks Telegram; the pipeline runs in the chat consumer.
  const capture: IngestionQueueMessage = {
    type: 'sms_inbound', tenantId,
    payload: { from: String(chatId), text, occurredAt, channel: 'telegram' },
    enqueuedAt: Date.now(),
  }
  const chatPayload: ChatInboundPayload = {
    channel: 'telegram', chatId, text, occurredAt,
    ...(typeof update.update_id === 'number' ? { updateId: update.update_id } : {}),
  }
  const chat: IngestionQueueMessage = {
    type: 'chat_inbound', tenantId,
    payload: chatPayload as unknown as Record<string, unknown>,
    enqueuedAt: Date.now(),
  }
  await Promise.all([env.QUEUE_HIGH.send(capture), env.QUEUE_HIGH.send(chat)])
  return { handled: true, kind: 'text' }
}
