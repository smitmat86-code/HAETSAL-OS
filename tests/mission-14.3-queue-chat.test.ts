// Mission 14.3: queue-side chat contracts — the reply job is idempotent on
// the Telegram update_id (a redelivered/retried job never double-replies),
// a failed send throws BEFORE any marker (safe retry), and success sets the
// 24h marker.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { processChatInbound } from '../src/workers/ingestion/chat-consumer'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-mission-143-${SUITE_ID}`
const CHAT_ID = 424242
const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function chatEnv(): Env {
  return {
    ...env,
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    AI: { run: async () => ({ response: 'Grounded reply here.' }) },
    QUEUE_HIGH: { send: async () => {} },
  } as unknown as Env
}

function stubTelegram(sendStatuses: number[]): { sends: number } {
  const state = { sends: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('sendMessage')) {
      const status = sendStatuses[Math.min(state.sends, sendStatuses.length - 1)] ?? 200
      state.sends += 1
      return new Response('{"ok":true}', { status })
    }
    return new Response('{}', { status: 200 })
  }))
  return state
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()
})

afterEach(() => vi.unstubAllGlobals())

describe('mission 14.3 — queue-side chat reply job', () => {
  it('replies once and sets the update_id marker', async () => {
    const state = stubTelegram([200])
    const updateId = Math.floor(Math.random() * 1e9)
    await processChatInbound(TENANT_ID, {
      channel: 'telegram', chatId: CHAT_ID, text: 'hello brain', occurredAt: Date.now(), updateId,
    }, chatEnv(), noopCtx)
    expect(state.sends).toBe(1)
    expect(await env.KV_SESSION.get(`tg_replied:${TENANT_ID}:${updateId}`)).toBe('1')
  })

  it('a redelivered job with the same update_id does not reply again', async () => {
    const state = stubTelegram([200])
    const updateId = Math.floor(Math.random() * 1e9)
    const payload = { channel: 'telegram', chatId: CHAT_ID, text: 'hello again', occurredAt: Date.now(), updateId }
    await processChatInbound(TENANT_ID, payload, chatEnv(), noopCtx)
    await processChatInbound(TENANT_ID, payload, chatEnv(), noopCtx)
    expect(state.sends).toBe(1)
  })

  it('a failed send throws before any marker exists (retry is safe)', async () => {
    stubTelegram([500])
    const updateId = Math.floor(Math.random() * 1e9)
    await expect(processChatInbound(TENANT_ID, {
      channel: 'telegram', chatId: CHAT_ID, text: 'flaky delivery', occurredAt: Date.now(), updateId,
    }, chatEnv(), noopCtx)).rejects.toThrow('TelegramSendFailed')
    expect(await env.KV_SESSION.get(`tg_replied:${TENANT_ID}:${updateId}`)).toBeNull()
  })

  it('ignores malformed payloads without throwing', async () => {
    const state = stubTelegram([200])
    await processChatInbound(TENANT_ID, { channel: 'telegram', text: 'no chat id' }, chatEnv(), noopCtx)
    expect(state.sends).toBe(0)
  })
})
