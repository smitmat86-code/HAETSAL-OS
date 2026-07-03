// src/services/delivery/telegram.ts
// Telegram bot message delivery. Two paths:
//  - sendTelegramReply(chatId, text, env): direct chat, used by inbound
//    handlers that already have the chat_id from the incoming update.
//  - sendTelegramMessage(tenantId, text, env): tenant-first lookup used by
//    crons/agents that only know which tenant they belong to.
// Silent skip if no chat mapping — not an error.

import type { Env } from '../../types/env'

export interface TelegramSendOptions {
  parseMode?: 'HTML' | 'MarkdownV2'
  disablePreview?: boolean
}

/** Send to a specific chat_id (known ahead of time, e.g. from an inbound update). */
export async function sendTelegramReply(
  chatId: number | string,
  message: string,
  env: Env,
  options?: TelegramSendOptions,
): Promise<boolean> {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: options?.parseMode ?? 'HTML',
        disable_web_page_preview: options?.disablePreview ?? true,
      }),
    },
  )
  return res.ok
}

/** Tenant-first delivery: look up the mapped chat_id and send. */
export async function sendTelegramMessage(
  tenantId: string,
  message: string,
  env: Env,
  options?: TelegramSendOptions,
): Promise<boolean> {
  const kvChatId = await env.KV_SESSION.get(`telegram_chat_id:${tenantId}`)
  let chatId = kvChatId
  if (!chatId) {
    const row = await env.D1_US.prepare(
      'SELECT chat_id FROM telegram_chats WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1',
    ).bind(tenantId).first<{ chat_id: number }>()
    if (row?.chat_id != null) chatId = String(row.chat_id)
  }
  if (!chatId) return false
  return sendTelegramReply(chatId, message, env, options)
}
