// src/services/ops-alert/deliver.ts
// Shallow page delivery for ops alerts (spec M4 / ADR-0006): iMessage via
// Sendblue first, Telnyx SMS fallback. NO memory broker, LLM, or DO session
// on this path — reliability is the whole point.

import type { Env } from '../../types/env'
import { sendSendblueMessage } from '../delivery/sendblue'
import { sendSmsReply } from '../delivery/sms'

export interface OpsPageDelivery {
  delivered: boolean
  channel: 'sendblue' | 'sms' | null
}

export async function resolveNotifyPhone(tenantId: string, env: Env): Promise<string | null> {
  const row = await env.D1_US.prepare(
    `SELECT phone_e164 FROM tenant_phone_numbers WHERE tenant_id = ?
     ORDER BY CASE WHEN label = 'primary' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
  ).bind(tenantId).first<{ phone_e164: string }>()
  return row?.phone_e164 ?? null
}

export async function deliverOpsPage(
  tenantId: string,
  message: string,
  env: Env,
): Promise<OpsPageDelivery> {
  const phone = await resolveNotifyPhone(tenantId, env)
  if (!phone) {
    console.error('OPS_ALERT_NO_PHONE', { tenantId })
    return { delivered: false, channel: null }
  }
  // Sendblue Free Tier can reject sends outside the 24h reply window —
  // treat any failure as "fall through to SMS", never as terminal.
  try {
    const viaSendblue = await sendSendblueMessage(phone, message, env)
    if (viaSendblue.success) return { delivered: true, channel: 'sendblue' }
  } catch { /* fall through to SMS */ }
  try {
    if (await sendSmsReply(phone, message, env)) return { delivered: true, channel: 'sms' }
  } catch { /* fall through to failure */ }
  console.error('OPS_ALERT_DELIVERY_FAILED', { tenantId })
  return { delivered: false, channel: null }
}
