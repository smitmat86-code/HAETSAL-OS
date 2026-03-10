// src/services/delivery/telegram.ts
// Telegram bot message delivery
// Silent skip if no chat_id configured — not an error

import type { Env } from '../../types/env'

export async function sendTelegramMessage(
  tenantId: string,
  message: string,
  env: Env,
  options?: { parseMode?: 'HTML' | 'MarkdownV2'; disablePreview?: boolean },
): Promise<boolean> {
  const chatId = await env.KV_SESSION.get(`telegram_chat_id:${tenantId}`)
  if (!chatId) return false

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
