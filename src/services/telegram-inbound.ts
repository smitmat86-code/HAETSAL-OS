// Telegram inbound processing (mission Phase 4.1; queue-side since 14.3).
// Text -> TWO durable jobs enqueued before the webhook acks: sms_inbound
// (canonical capture, unchanged) + chat_inbound (the reply pipeline runs in
// the queue consumer — src/workers/ingestion/chat-consumer.ts). Photo -> one
// durable governed operation plus an opaque queue locator. Tenant routing is
// chat.id -> tenant via telegram_chats D1 table.

import type { Env } from '../types/env'
import type { ChatInboundPayload, IngestionQueueMessage } from '../types/ingestion'
import { acceptChannelMedia } from './channel-media/intake'

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
}
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

export async function processTelegramInbound(
  update: TelegramUpdate,
  env: Env,
  _ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<{ handled: boolean; kind: 'text' | 'media' | 'ignored' | 'command' }> {
  const msg = update.message
  const chatId = msg?.chat?.id
  if (!msg || typeof chatId !== 'number' || msg.from?.is_bot) return { handled: false, kind: 'ignored' }
  const tenantId = await resolveTelegramTenant(chatId, env)
  if (!tenantId) {
    console.warn('TELEGRAM_UNKNOWN_CHAT')
    return { handled: false, kind: 'ignored' }
  }
  const occurredAt = typeof msg.date === 'number' ? msg.date * 1000 : Date.now()

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) => ((a.file_size ?? 0) > (b.file_size ?? 0) ? a : b))
    const eventIdentity = typeof update.update_id === 'number'
      ? `update:${update.update_id}`
      : `file:${largest.file_unique_id ?? largest.file_id}`
    await acceptChannelMedia({
      tenantId,
      provider: 'telegram',
      eventIdentity,
      descriptor: {
        version: 1,
        provider: 'telegram',
        locatorKind: 'telegram_file_id',
        locator: largest.file_id,
        replyTarget: String(chatId),
        caption: msg.caption ?? null,
        occurredAt,
      },
    }, env)
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
