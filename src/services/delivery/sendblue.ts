// Sendblue iMessage outbound client (mission Phase 4).
// Free Tier caveat: shared number, must-text-first, 24h reply window —
// sends outside the window are rejected by Sendblue; callers must treat that
// as a skip, not an error to retry (mission Phase 7 automation rule).

import type { Env } from '../../types/env'

const SENDBLUE_API_BASE = 'https://api.sendblue.co'

export interface SendblueSendResult {
  success: boolean
  status: number
  errorCode?: string | null
}

export function sendblueAuthHeaders(env: Env): Record<string, string> {
  return {
    'sb-api-key-id': env.SENDBLUE_API_KEY_ID,
    'sb-api-secret-key': env.SENDBLUE_API_SECRET_KEY,
    'Content-Type': 'application/json',
  }
}

export async function sendSendblueMessage(
  number: string,
  content: string,
  env: Env,
  options?: { mediaUrl?: string | null },
): Promise<SendblueSendResult> {
  try {
    const response = await fetch(`${SENDBLUE_API_BASE}/api/send-message`, {
      method: 'POST',
      headers: sendblueAuthHeaders(env),
      body: JSON.stringify({
        from_number: env.SENDBLUE_PHONE_NUMBER,
        number,
        content,
        ...(options?.mediaUrl ? { media_url: options.mediaUrl } : {}),
      }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error_code?: string; error_message?: string }
      // Metadata-only logging: status + error code, never message content.
      console.warn('SENDBLUE_SEND_FAILED', {
        status: response.status,
        errorCode: body.error_code ?? null,
      })
      return { success: false, status: response.status, errorCode: body.error_code ?? null }
    }
    return { success: true, status: response.status }
  } catch (error) {
    console.warn('SENDBLUE_SEND_ERROR', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { success: false, status: 0 }
  }
}
