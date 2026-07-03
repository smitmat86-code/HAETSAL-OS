// src/workers/mcpagent/do/action-scheduling.ts
// DO-side helpers for scheduled/deferred action work. Kept out of McpAgent.ts
// for the line limit. The reminder message is TMK-encrypted before it is stored
// in the Agents SDK schedule table (cf_agents_schedules), so no plaintext user
// content sits at rest outside the canonical boundary (Law 2). It is decrypted
// only transiently at fire time, then delivered over the tenant's channel.

import type { Env } from '../../../types/env'
import { decryptWithKek, encryptWithKek } from '../../../cron/kek'
import { sendTelegramMessage } from '../../../services/delivery/telegram'
import { sendSmsReply } from '../../../services/delivery/sms'

export interface ReminderSchedulePayload {
  ciphertext: string
  channel?: string
}

type ScheduleFn = (when: Date, callback: string, payload: unknown) => Promise<unknown>

/** Encrypt the reminder message and register the scheduler callback. Keeps the
 *  encrypt + schedule wiring out of the DO class (line limit). */
export async function scheduleReminder(
  schedule: ScheduleFn,
  tmk: CryptoKey,
  remindAtMs: number,
  message: string,
  channel?: string,
): Promise<{ scheduledFor: number }> {
  const payload: ReminderSchedulePayload = { ciphertext: await encryptWithKek(message, tmk), channel }
  await schedule(new Date(remindAtMs), 'fireReminder', payload)
  return { scheduledFor: remindAtMs }
}

/** Fire a due reminder: decrypt the message with the tenant TMK and deliver it
 *  over the tenant's channel (Telegram first; SMS fallback if configured). */
export async function deliverReminder(
  env: Env,
  tenantId: string,
  tmk: CryptoKey,
  payload: ReminderSchedulePayload,
): Promise<void> {
  const message = await decryptWithKek(payload.ciphertext, tmk)
  const text = `⏰ Reminder: ${message}`
  const viaTelegram = await sendTelegramMessage(tenantId, text, env).catch(() => false)
  if (viaTelegram) return
  // Fallback: SMS to the tenant's registered number, if any.
  const row = await env.D1_US.prepare(
    'SELECT phone_e164 FROM tenant_phone_numbers WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1',
  ).bind(tenantId).first<{ phone_e164: string }>()
  if (row?.phone_e164) await sendSmsReply(row.phone_e164, text, env).catch(() => false)
}
