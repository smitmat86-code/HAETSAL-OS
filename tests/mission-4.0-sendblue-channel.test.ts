// Mission Phase 4: Sendblue iMessage channel contracts — webhook path-secret
// auth (constant time), line validation, text -> grounded reply + queued
// capture, governed opaque photo intake, outbound client shape.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { registerPublicWebhooks } from '../src/workers/mcpagent/public-webhooks'
import { sendSendblueMessage } from '../src/services/delivery/sendblue'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-mission-40-${SUITE_ID}`
const MATT_PHONE = '+15550001111'
const LINE_NUMBER = '+16452067656'
const PATH_SECRET = 'test-sendblue-path-secret'

installCanonicalMemoryTestStore(env)

type SentRequest = { url: string; init?: RequestInit }

function makeSendblueEnv(sent: SentRequest[], queue: unknown[]) {
  const testEnv = {
    ...env,
    SENDBLUE_API_KEY_ID: 'test-key-id',
    SENDBLUE_API_SECRET_KEY: 'test-secret-key',
    SENDBLUE_PHONE_NUMBER: LINE_NUMBER,
    SENDBLUE_WEBHOOK_PATH_SECRET: PATH_SECRET,
    AI: {
      // Vision calls carry an image_url content part; replies are plain text.
      // Vision answers in the OpenAI shape, text in the legacy {response}
      // shape, so both readChatText branches stay covered.
      run: async (_model: string, input: unknown) => (
        JSON.stringify(input).includes('image_url')
          ? { choices: [{ message: { role: 'assistant', content: 'A whiteboard covered in project notes.' } }] }
          : { response: 'Here is what I remember.' }
      ),
    },
    QUEUE_HIGH: { send: async (message: unknown) => { queue.push(message) } },
  } as unknown as Env
  return testEnv
}

function stubFetch(sent: SentRequest[], mediaBytes?: ArrayBuffer) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    sent.push({ url, init })
    if (url.includes('api.sendblue.co')) {
      return new Response(JSON.stringify({ status: 'QUEUED' }), { status: 200 })
    }
    if (url.includes('media.example')) {
      return new Response(mediaBytes ?? new ArrayBuffer(8), {
        status: 200, headers: { 'content-type': 'image/jpeg' },
      })
    }
    return new Response('{}', { status: 200 })
  })
}

function makeApp(testEnv: Env) {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string; jwtSub: string; traceId: string } }>()
  registerPublicWebhooks(app as never)
  return {
    post: (path: string, body: unknown) => app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, testEnv),
  }
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    content: 'what did I capture about Atlas?',
    from_number: MATT_PHONE,
    to_number: LINE_NUMBER,
    is_outbound: false,
    date_sent: new Date().toISOString(),
    ...overrides,
  }
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenant_phone_numbers (id, tenant_id, phone_e164, label, created_at)
     VALUES (?, ?, ?, 'primary', ?)`,
  ).bind(crypto.randomUUID(), TENANT_ID, MATT_PHONE, now).run()
  const raw = crypto.getRandomValues(new Uint8Array(32))
  await env.KV_SESSION.put(`cron_kek:${TENANT_ID}`, btoa(String.fromCharCode(...raw)))
  await env.D1_US.prepare(
    'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
  ).bind(now + 3_600_000, TENANT_ID).run()
})

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mission 4.0 — webhook authentication', () => {
  it('rejects a wrong path secret with 404 and never processes', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const app = makeApp(makeSendblueEnv(sent, queue))
    const response = await app.post('/webhooks/sendblue/wrong-secret', inbound())
    expect(response.status).toBe(404)
    expect(queue).toHaveLength(0)
    expect(sent.filter((request) => request.url.includes('sendblue'))).toHaveLength(0)
  })

  it('ignores messages addressed to a different line', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const app = makeApp(makeSendblueEnv(sent, queue))
    const response = await app.post(`/webhooks/sendblue/${PATH_SECRET}`, inbound({ to_number: '+19998887777' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ignored' })
    expect(queue).toHaveLength(0)
  })

  it('ignores unknown senders on the shared line without replying', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const app = makeApp(makeSendblueEnv(sent, queue))
    const response = await app.post(`/webhooks/sendblue/${PATH_SECRET}`, inbound({ from_number: '+15559999999' }))
    expect(response.status).toBe(200)
    expect((await response.json() as { kind: string }).kind).toBe('ignored')
    expect(queue).toHaveLength(0)
    expect(sent.filter((request) => request.url.includes('sendblue'))).toHaveLength(0)
  })

  it('ignores outbound-echo webhooks', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const app = makeApp(makeSendblueEnv(sent, queue))
    const response = await app.post(`/webhooks/sendblue/${PATH_SECRET}`, inbound({ is_outbound: true }))
    expect((await response.json() as { kind: string }).kind).toBe('ignored')
    expect(queue).toHaveLength(0)
  })
})

describe('mission 4.0 — inbound text flow', () => {
  it('queues a canonical capture and sends a grounded reply', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const app = makeApp(makeSendblueEnv(sent, queue))
    const response = await app.post(`/webhooks/sendblue/${PATH_SECRET}`, inbound())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'processed', kind: 'text' })

    const message = queue[0] as { type: string; tenantId: string; payload: Record<string, unknown> }
    expect(message.type).toBe('sms_inbound')
    expect(message.tenantId).toBe(TENANT_ID)
    expect(message.payload.channel).toBe('sendblue')
    expect(message.payload.from).toBe(MATT_PHONE)

    const send = sent.find((request) => request.url.includes('api.sendblue.co/api/send-message'))
    expect(send).toBeTruthy()
    const body = JSON.parse(String(send!.init?.body)) as Record<string, string>
    expect(body.from_number).toBe(LINE_NUMBER)
    expect(body.number).toBe(MATT_PHONE)
    expect(body.content.length).toBeGreaterThan(0)
    const headers = send!.init?.headers as Record<string, string>
    expect(headers['sb-api-key-id']).toBe('test-key-id')
    expect(headers['sb-api-secret-key']).toBe('test-secret-key')
  })
})

describe('mission 4.0 — photo flow', () => {
  it('accepts one durable opaque job without fetching the temporary URL or replying inline', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    const bytes = new TextEncoder().encode('fake-jpeg-bytes').buffer as ArrayBuffer
    stubFetch(sent, bytes)
    const app = makeApp(makeSendblueEnv(sent, queue))
    const response = await app.post(`/webhooks/sendblue/${PATH_SECRET}`, inbound({
      content: 'whiteboard from today',
      media_url: 'https://media.example/photo.jpg',
      message_handle: 'stable-sendblue-message-handle',
    }))

    expect(await response.json()).toMatchObject({ status: 'processed', kind: 'media' })
    const message = queue[0] as { type: string; payload: Record<string, unknown> }
    expect(message.type).toBe('channel_media')
    expect(Object.keys(message.payload)).toEqual(['operationId'])
    expect(JSON.stringify(message)).not.toContain('https://media.example/photo.jpg')
    expect(JSON.stringify(message)).not.toContain('stable-sendblue-message-handle')
    expect(JSON.stringify(message)).not.toContain('whiteboard from today')
    expect(JSON.stringify(message)).not.toContain(MATT_PHONE)
    expect(sent.some((request) => request.url.includes('media.example'))).toBe(false)
    expect(sent.some((request) => request.url.includes('/api/send-message'))).toBe(false)
    expect((await env.R2_ARTIFACTS.list({ prefix: `sendblue-media/${TENANT_ID}/` })).objects).toHaveLength(0)
  })
})

describe('mission 4.0 — outbound client', () => {
  it('reports failure metadata without throwing when Sendblue rejects', async () => {
    const sent: SentRequest[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: input.toString(), init })
      return new Response(JSON.stringify({ error_code: 'OUTSIDE_REPLY_WINDOW' }), { status: 422 })
    })
    const result = await sendSendblueMessage(MATT_PHONE, 'hello', makeSendblueEnv(sent, []))
    expect(result.success).toBe(false)
    expect(result.status).toBe(422)
    expect(result.errorCode).toBe('OUTSIDE_REPLY_WINDOW')
  })
})
