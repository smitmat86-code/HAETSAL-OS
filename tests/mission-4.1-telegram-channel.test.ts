// Mission Phase 4.1: Telegram channel contracts — webhook secret auth,
// unknown-chat ignore, bot-echo ignore, slash-command skip, text -> grounded
// reply + queued canonical capture, governed opaque photo intake.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { registerPublicWebhooks } from '../src/workers/mcpagent/public-webhooks'
import { processChatInbound } from '../src/workers/ingestion/chat-consumer'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-mission-41-${SUITE_ID}`
const CHAT_ID = 987654321
const SECRET = 'test-telegram-secret'

installCanonicalMemoryTestStore(env)

type SentRequest = { url: string; init?: RequestInit }

function makeTgEnv(sent: SentRequest[], queue: unknown[]) {
  return {
    ...env,
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    AI: {
      run: async (_model: string, input: unknown) => (
        JSON.stringify(input).includes('image_url')
          ? { choices: [{ message: { role: 'assistant', content: 'A whiteboard covered in project notes.' } }] }
          : { response: 'Here is what I remember.' }
      ),
    },
    QUEUE_HIGH: { send: async (message: unknown) => { queue.push(message) } },
  } as unknown as Env
}

function stubFetch(sent: SentRequest[], photoBytes?: ArrayBuffer) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    sent.push({ url, init })
    if (url.includes('/getFile?')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/file_123.jpg' } }), { status: 200 })
    }
    if (url.includes('api.telegram.org/file/')) {
      return new Response(photoBytes ?? new ArrayBuffer(8), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    if (url.includes('api.telegram.org/bot')) return new Response('{"ok":true}', { status: 200 })
    return new Response('{}', { status: 200 })
  })
}

function makeApp(testEnv: Env) {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string; jwtSub: string; traceId: string } }>()
  registerPublicWebhooks(app as never)
  return {
    post: (path: string, body: unknown, secret: string = SECRET) => app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(body),
    }, testEnv),
  }
}

function update(overrides: Partial<{ chat: number; text: string; photo: unknown; caption: string; isBot: boolean }> = {}) {
  const chat = overrides.chat ?? CHAT_ID
  const msg: Record<string, unknown> = { chat: { id: chat }, from: { id: 42, is_bot: overrides.isBot ?? false }, date: Math.floor(Date.now() / 1000) }
  if (overrides.text !== undefined) msg.text = overrides.text
  if (overrides.photo) msg.photo = overrides.photo
  if (overrides.caption !== undefined) msg.caption = overrides.caption
  return { update_id: 7654321, message: msg }
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO telegram_chats (id, tenant_id, chat_id, label, created_at) VALUES (?, ?, ?, 'primary', ?)`,
  ).bind(crypto.randomUUID(), TENANT_ID, CHAT_ID, now).run()
  const raw = crypto.getRandomValues(new Uint8Array(32))
  await env.KV_SESSION.put(`cron_kek:${TENANT_ID}`, btoa(String.fromCharCode(...raw)))
  await env.D1_US.prepare(
    'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
  ).bind(now + 3_600_000, TENANT_ID).run()
})

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mission 4.1 — telegram webhook auth', () => {
  it('rejects wrong X-Telegram-Bot-Api-Secret-Token with 403', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent)
    const res = await makeApp(makeTgEnv(sent, queue)).post('/telegram/webhook', update({ text: 'hi' }), 'wrong')
    expect(res.status).toBe(403)
    expect(queue).toHaveLength(0)
  })

  it('ignores unknown chats without replying', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent)
    const res = await makeApp(makeTgEnv(sent, queue)).post('/telegram/webhook', update({ chat: 111, text: 'hi' }))
    expect(res.status).toBe(200)
    expect(queue).toHaveLength(0)
    expect(sent.filter((r) => r.url.includes('sendMessage'))).toHaveLength(0)
  })

  it('ignores bot messages', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent)
    await makeApp(makeTgEnv(sent, queue)).post('/telegram/webhook', update({ text: 'echo', isBot: true }))
    expect(queue).toHaveLength(0)
  })

  it('skips slash commands', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent)
    await makeApp(makeTgEnv(sent, queue)).post('/telegram/webhook', update({ text: '/start' }))
    expect(queue).toHaveLength(0)
    expect(sent.filter((r) => r.url.includes('sendMessage'))).toHaveLength(0)
  })
})

describe('mission 4.1 — telegram inbound text flow (queue-side since 14.3)', () => {
  it('webhook enqueues capture + chat jobs durably, without replying inline', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent)
    const res = await makeApp(makeTgEnv(sent, queue)).post('/telegram/webhook', update({ text: 'what about Atlas?' }))
    expect(res.status).toBe(200)
    const msgs = queue as Array<{ type: string; tenantId: string; payload: Record<string, unknown> }>
    expect(msgs).toHaveLength(2)
    const capture = msgs.find((m) => m.type === 'sms_inbound')!
    expect(capture.tenantId).toBe(TENANT_ID)
    expect(capture.payload.channel).toBe('telegram')
    expect(capture.payload.from).toBe(String(CHAT_ID))
    const chat = msgs.find((m) => m.type === 'chat_inbound')!
    expect(chat.payload.chatId).toBe(CHAT_ID)
    expect(chat.payload.text).toBe('what about Atlas?')
    expect(sent.filter((r) => r.url.includes('sendMessage'))).toHaveLength(0)
  })

  it('the chat consumer sends the grounded reply for the queued job', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent)
    const testEnv = makeTgEnv(sent, queue)
    await processChatInbound(TENANT_ID, {
      channel: 'telegram', chatId: CHAT_ID, text: 'what about Atlas?', occurredAt: Date.now(),
    }, testEnv, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    const reply = sent.find((r) => r.url.includes('sendMessage'))
    expect(reply).toBeTruthy()
    const body = JSON.parse(String(reply!.init?.body)) as Record<string, unknown>
    expect(body.chat_id).toBe(CHAT_ID)
    expect(String(body.text).length).toBeGreaterThan(0)
  })
})

describe('mission 4.1 — telegram photo flow', () => {
  it('accepts one durable opaque job without fetching, storing plaintext, or replying inline', async () => {
    const sent: SentRequest[] = []; const queue: unknown[] = []
    stubFetch(sent, new TextEncoder().encode('fake-jpeg').buffer as ArrayBuffer)
    const res = await makeApp(makeTgEnv(sent, queue)).post('/telegram/webhook', update({
      photo: [{ file_id: 'small', file_size: 100 }, { file_id: 'big', file_size: 900 }],
      caption: 'planning session',
    }))
    expect(res.status).toBe(200)
    expect(queue).toHaveLength(1)
    const msg = queue[0] as { type: string; payload: Record<string, unknown> }
    expect(msg.type).toBe('channel_media')
    expect(Object.keys(msg.payload)).toEqual(['operationId'])
    expect(String(msg.payload.operationId)).toMatch(/^[a-f0-9-]{36}$/i)
    expect(JSON.stringify(msg)).not.toContain('big')
    expect(JSON.stringify(msg)).not.toContain('planning session')
    expect(JSON.stringify(msg)).not.toContain(String(CHAT_ID))
    expect(sent.some((r) => r.url.includes('/getFile?'))).toBe(false)
    expect(sent.some((r) => r.url.includes('sendMessage'))).toBe(false)
    expect((await env.R2_ARTIFACTS.list({ prefix: `telegram-media/${TENANT_ID}/` })).objects).toHaveLength(0)
  })
})
