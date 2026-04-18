import type { Env } from '../types/env'
import { listWebhooks } from './hindsight'

export interface HindsightWebhookHealth {
  status: 'ok' | 'missing' | 'unknown'
  total: number
  enabled: number
  error?: string
}

export async function getWebhookHealth(
  env: Env,
  bankId: string | null,
): Promise<HindsightWebhookHealth> {
  if (!bankId) {
    return { status: 'unknown', total: 0, enabled: 0, error: 'No bank id yet' }
  }

  try {
    const webhooks = await listWebhooks(bankId, env)
    const items = webhooks.items ?? []
    const enabled = items.filter((item) => item.enabled).length
    return {
      status: enabled > 0 ? 'ok' : 'missing',
      total: items.length,
      enabled,
    }
  } catch (error) {
    return {
      status: 'unknown',
      total: 0,
      enabled: 0,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    }
  }
}
