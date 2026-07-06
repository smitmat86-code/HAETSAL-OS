// src/workers/mcpagent/routes/system-telegram.ts
// Phase 14.1 ops: Telegram webhook diagnostics + re-registration. The worker
// holds TELEGRAM_BOT_TOKEN as a secret, so it queries Telegram itself.
// G2: responses and logs carry NO token — only registration metadata.
// Context: the custom-domain move left the CF Access bypass app pointing at
// the old workers.dev host, so real Telegram deliveries die at the edge of
// haetsalos.* (401) while the workers.dev path still works (bypass + our
// secret-header check in public-webhooks.ts).

import { Hono } from 'hono'
import type { Env } from '../../../types/env'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const WEBHOOK_HOSTS = {
  custom: 'haetsalos.specialdarksystems.com',
  workersdev: 'the-brain.ct-trading-bot1.workers.dev',
} as const

export const systemTelegram = new Hono<{ Bindings: Env; Variables: Variables }>()

async function telegramApi(
  env: Env, method: string, body?: Record<string, unknown>,
): Promise<{ ok?: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return await res.json() as { ok?: boolean; result?: unknown; description?: string }
}

systemTelegram.get('/webhook', async (c) => {
  const info = await telegramApi(c.env, 'getWebhookInfo')
  const r = (info.result ?? {}) as Record<string, unknown>
  return c.json({
    ok: info.ok === true,
    url: typeof r.url === 'string' ? r.url : '',
    pendingUpdateCount: typeof r.pending_update_count === 'number' ? r.pending_update_count : 0,
    lastErrorDate: typeof r.last_error_date === 'number' ? r.last_error_date : null,
    lastErrorMessage: typeof r.last_error_message === 'string' ? r.last_error_message : null,
    ipAddress: typeof r.ip_address === 'string' ? r.ip_address : null,
  })
})

systemTelegram.post('/webhook/register', async (c) => {
  const body = await c.req.json<{ target?: string }>().catch(() => ({} as { target?: string }))
  const target: keyof typeof WEBHOOK_HOSTS = body.target === 'workersdev' ? 'workersdev' : 'custom'
  const host = WEBHOOK_HOSTS[target]
  const result = await telegramApi(c.env, 'setWebhook', {
    url: `https://${host}/telegram/webhook`,
    secret_token: c.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: false, // queued updates (≤24h) deliver after the fix — late replies expected
  })
  return c.json({
    ok: result.ok === true,
    description: result.description ?? null,
    registeredUrl: `https://${host}/telegram/webhook`,
  })
})
