// src/services/delivery/sms.ts
// Telnyx v2 SMS delivery — sends reply back to user
// Uses TELNYX_API_KEY secret + TELNYX_FROM_NUMBER env var

import type { Env } from '../../types/env'

/**
 * Send an SMS reply via Telnyx v2 Messages API
 * Returns true if successfully queued, false otherwise
 */
export async function sendSmsReply(
  to: string,
  message: string,
  env: Env,
): Promise<boolean> {
  const apiKey = env.TELNYX_API_KEY?.trim()
  const fromNumber = env.TELNYX_FROM_NUMBER?.trim()
  console.log('TELNYX_SEND: to:', to, 'from:', fromNumber, 'msgLen:', message.length, 'keyLen:', apiKey?.length)
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromNumber,
      to,
      text: message,
    }),
  })
  const resBody = await res.text()
  console.log('TELNYX_SEND_RESULT:', res.status, resBody.substring(0, 500))
  return res.ok
}
