// Mission 14.1: Telegram webhook ops route contracts — the diagnostics
// response never carries the bot token (G2), and registration posts the
// secret_token from env to the Telegram API with pending updates preserved.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemTelegram } from '../src/workers/mcpagent/routes/system-telegram'
import type { Env } from '../src/types/env'

const FAKE_TOKEN = `fake-bot-token-${crypto.randomUUID()}`
const FAKE_SECRET = `fake-webhook-secret-${crypto.randomUUID()}`
const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_WEBHOOK_SECRET: FAKE_SECRET } as unknown as Env

afterEach(() => vi.unstubAllGlobals())

describe('mission 14.1 — telegram webhook ops', () => {
  it('GET /webhook sanitizes: registration metadata only, never the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        url: 'https://haetsalos.specialdarksystems.com/telegram/webhook',
        pending_update_count: 4,
        last_error_date: 1783270000,
        last_error_message: 'wrong response from the webhook: 401 Unauthorized',
        ip_address: '104.21.0.1',
      },
    }))))
    const res = await systemTelegram.request('/webhook', {}, env)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(FAKE_TOKEN)
    const parsed = JSON.parse(text) as { ok: boolean; pendingUpdateCount: number; lastErrorMessage: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.pendingUpdateCount).toBe(4)
    expect(parsed.lastErrorMessage).toContain('401')
  })

  it('POST /webhook/register sends secret_token + keeps pending updates; response is token-free', async () => {
    const calls: Array<{ url: string; body: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return new Response(JSON.stringify({ ok: true, result: true, description: 'Webhook was set' }))
    }))
    const res = await systemTelegram.request('/webhook/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'workersdev' }),
    }, env)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(FAKE_TOKEN)
    expect(text).not.toContain(FAKE_SECRET)
    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>
    expect(calls[0]!.url).toContain('/setWebhook')
    expect(sent.url).toBe('https://the-brain.ct-trading-bot1.workers.dev/telegram/webhook')
    expect(sent.secret_token).toBe(FAKE_SECRET)
    expect(sent.drop_pending_updates).toBe(false)
    expect(JSON.parse(text)).toMatchObject({ ok: true, registeredUrl: 'https://the-brain.ct-trading-bot1.workers.dev/telegram/webhook' })
  })

  it('unknown target falls back to the custom domain', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ ok: true }))
    }))
    await systemTelegram.request('/webhook/register', { method: 'POST', body: '{}' }, env)
    expect((JSON.parse(calls[0]!) as { url: string }).url)
      .toBe('https://haetsalos.specialdarksystems.com/telegram/webhook')
  })
})
