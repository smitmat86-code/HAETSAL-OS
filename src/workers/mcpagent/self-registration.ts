// src/workers/mcpagent/self-registration.ts
// Query-string self-registration used by the GET / status page:
//   ?phone=%2B15551234567       -> tenant_phone_numbers
//   ?telegram_chat_id=12345      -> telegram_chats (+ KV for cron backwards-compat)

import type { Env } from '../../types/env'

export async function registerPhoneQuery(
  env: Env, tenantId: string, phone: string,
): Promise<string> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return '<p>Phone must be E.164 format, e.g. ?phone=%2B15551234567 (use %2B for +).</p>'
  }
  await env.D1_US.prepare(
    `INSERT INTO tenant_phone_numbers (id, tenant_id, phone_e164, label, created_at)
     SELECT ?, ?, ?, 'primary', ?
     WHERE NOT EXISTS (SELECT 1 FROM tenant_phone_numbers WHERE phone_e164 = ?)`,
  ).bind(crypto.randomUUID(), tenantId, phone, Date.now(), phone).run()
  return `<p>Phone <code>&hellip;${phone.slice(-4)}</code> is registered to your tenant for iMessage/SMS.</p>`
}

export async function registerTelegramQuery(
  env: Env, tenantId: string, raw: string,
): Promise<string> {
  const chatId = Number(raw)
  if (!Number.isInteger(chatId) || chatId === 0) {
    return '<p>telegram_chat_id must be an integer, e.g. ?telegram_chat_id=123456789.</p>'
  }
  await env.D1_US.prepare(
    `INSERT INTO telegram_chats (id, tenant_id, chat_id, label, created_at)
     SELECT ?, ?, ?, 'primary', ?
     WHERE NOT EXISTS (SELECT 1 FROM telegram_chats WHERE chat_id = ?)`,
  ).bind(crypto.randomUUID(), tenantId, chatId, Date.now(), chatId).run()
  await env.KV_SESSION.put(`telegram_chat_id:${tenantId}`, String(chatId))
  return `<p>Telegram chat <code>&hellip;${String(chatId).slice(-4)}</code> is registered to your tenant.</p>`
}
