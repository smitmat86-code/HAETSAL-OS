// Mission M4 — ops-alert ingress contracts: per-source token auth (404 on
// unknown), canary {text} payload mapping, shallow page delivery with
// Sendblue→SMS fallback, dedupe-window replay safety, notice → brief only,
// async episodic memory enqueue, standing morning-brief ops section.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { Hono } from 'hono'
import { registerOpsAlertWebhook } from '../src/workers/mcpagent/ops-alert-webhook'
import { processOpsAlert } from '../src/services/ops-alert/ingest'
import { resolveOpsAlertSource, sha256Hex } from '../src/services/ops-alert/registry'
import { fetchOpsSection } from '../src/cron/brief-ops-section'
import type { OpsAlertSource } from '../src/types/ops-alert'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-m4-${SUITE_ID}`
const SOURCE_ID = `haetsal-health-${SUITE_ID}`
const MATT_PHONE = '+15550002222'
const TOKEN = `m4-test-token-${SUITE_ID}`

type SentRequest = { url: string; init?: RequestInit }

function makeTestEnv(sent: SentRequest[], queue: unknown[]) {
  return {
    ...env,
    SENDBLUE_API_KEY_ID: 'test-key-id',
    SENDBLUE_API_SECRET_KEY: 'test-secret-key',
    SENDBLUE_PHONE_NUMBER: '+16452067656',
    TELNYX_API_KEY: 'test-telnyx-key',
    TELNYX_FROM_NUMBER: '+13236785761',
    QUEUE_HIGH: { send: async (message: unknown) => { queue.push(message) } },
    QUEUE_NORMAL: { send: async (message: unknown) => { queue.push(message) } },
  } as unknown as Env
}

function stubFetch(sent: SentRequest[], opts?: { sendblueStatus?: number; telnyxStatus?: number }) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    sent.push({ url, init })
    if (url.includes('api.sendblue.co')) {
      const status = opts?.sendblueStatus ?? 200
      return new Response(JSON.stringify(status === 200 ? { status: 'QUEUED' } : { error_code: 'OUTSIDE_REPLY_WINDOW' }), { status })
    }
    if (url.includes('api.telnyx.com')) {
      return new Response('{"data":{}}', { status: opts?.telnyxStatus ?? 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

function makeApp(testEnv: Env) {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string; jwtSub: string; traceId: string } }>()
  registerOpsAlertWebhook(app)
  return {
    post: (path: string, body: unknown) => app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, testEnv),
  }
}

/** Capturing ctx so async memory enqueues can be drained (LESSONS: drain waitUntil). */
function makeCtx() {
  const promises: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { promises.push(p) } },
    drain: () => Promise.allSettled(promises),
  }
}

async function loadSource(): Promise<OpsAlertSource> {
  const source = await resolveOpsAlertSource(TOKEN, env as unknown as Env)
  if (!source) throw new Error('test source missing')
  return source
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
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO ops_alert_sources
     (id, tenant_id, token_sha256, default_severity, dedupe_window_s, enabled, created_at)
     VALUES (?, ?, ?, 'page', 21600, 1, ?)`,
  ).bind(SOURCE_ID, TENANT_ID, await sha256Hex(TOKEN), now).run()
})

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('m4 — ingress auth', () => {
  it('rejects an unknown token with 404 and sends nothing', async () => {
    const sent: SentRequest[] = []
    stubFetch(sent)
    const app = makeApp(makeTestEnv(sent, []))
    const response = await app.post('/ops/alert/wrong-token', { text: 'boom' })
    expect(response.status).toBe(404)
    expect(sent).toHaveLength(0)
  })

  it('rejects a disabled source with 404', async () => {
    const disabledToken = `disabled-${SUITE_ID}`
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO ops_alert_sources
       (id, tenant_id, token_sha256, default_severity, dedupe_window_s, enabled, created_at)
       VALUES (?, ?, ?, 'page', 21600, 0, ?)`,
    ).bind(`disabled-src-${SUITE_ID}`, TENANT_ID, await sha256Hex(disabledToken), Date.now()).run()
    const app = makeApp(makeTestEnv([], []))
    const response = await app.post(`/ops/alert/${disabledToken}`, { text: 'boom' })
    expect(response.status).toBe(404)
  })
})

describe('m4 — page path (canary {text} shape)', () => {
  it('pages via Sendblue, records paged_at, queues an episodic memory', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const { ctx, drain } = makeCtx()
    const source = await loadSource()
    const result = await processOpsAlert(source, {
      text: `canary: DLQ non-empty ${SUITE_ID}-a`,
    }, makeTestEnv(sent, queue), ctx)
    await drain()

    expect(result.outcome).toBe('paged')
    expect(result.severity).toBe('page') // source default applied
    const send = sent.find((r) => r.url.includes('api.sendblue.co'))
    expect(send).toBeTruthy()
    const body = JSON.parse(String(send!.init?.body)) as Record<string, string>
    expect(body.number).toBe(MATT_PHONE)
    expect(body.content).toContain('DLQ non-empty')

    const row = await env.D1_US.prepare(
      `SELECT severity, paged_at, page_channel, replay_count FROM ops_alerts WHERE id = ?`,
    ).bind(result.alertId).first<{ severity: string; paged_at: number | null; page_channel: string; replay_count: number }>()
    expect(row?.severity).toBe('page')
    expect(row?.paged_at).toBeTruthy()
    expect(row?.page_channel).toBe('sendblue')

    const memory = queue.find((m) => (m as { type: string }).type === 'retain_artifact') as
      { tenantId: string; payload: { artifact: { provenance: string; source: string } } } | undefined
    expect(memory).toBeTruthy()
    expect(memory!.tenantId).toBe(TENANT_ID)
    expect(memory!.payload.artifact.source).toBe('ops_alert')
    expect(memory!.payload.artifact.provenance).toBe(`ops_alert:${SOURCE_ID}`)
  })

  it('replay with the same dedupe key inside the window does not double-page', async () => {
    const sent: SentRequest[] = []
    stubFetch(sent)
    const { ctx, drain } = makeCtx()
    const source = await loadSource()
    const payload = { text: `canary: stale spine ${SUITE_ID}-b` }
    const testEnv = makeTestEnv(sent, [])

    const first = await processOpsAlert(source, payload, testEnv, ctx)
    expect(first.outcome).toBe('paged')
    const sendsAfterFirst = sent.filter((r) => r.url.includes('api.sendblue.co')).length

    const replay = await processOpsAlert(source, payload, testEnv, ctx)
    await drain()
    expect(replay.outcome).toBe('duplicate')
    expect(replay.alertId).toBe(first.alertId)
    expect(sent.filter((r) => r.url.includes('api.sendblue.co')).length).toBe(sendsAfterFirst)

    const row = await env.D1_US.prepare(
      `SELECT replay_count FROM ops_alerts WHERE id = ?`,
    ).bind(first.alertId).first<{ replay_count: number }>()
    expect(row?.replay_count).toBe(1)
  })

  it('re-pages the same key once the dedupe window has elapsed', async () => {
    const sent: SentRequest[] = []
    stubFetch(sent)
    const { ctx, drain } = makeCtx()
    const source = await loadSource()
    const payload = { text: `canary: ongoing outage ${SUITE_ID}-c` }
    const testEnv = makeTestEnv(sent, [])

    const first = await processOpsAlert(source, payload, testEnv, ctx)
    expect(first.outcome).toBe('paged')
    // Age the page out of the 6h window.
    await env.D1_US.prepare(
      `UPDATE ops_alerts SET paged_at = ? WHERE id = ?`,
    ).bind(Date.now() - 7 * 3_600_000, first.alertId).run()

    const again = await processOpsAlert(source, payload, testEnv, ctx)
    await drain()
    expect(again.outcome).toBe('paged')
    expect(sent.filter((r) => r.url.includes('api.sendblue.co')).length).toBe(2)
  })

  it('falls back to Telnyx SMS when Sendblue rejects', async () => {
    const sent: SentRequest[] = []
    stubFetch(sent, { sendblueStatus: 422 })
    const { ctx, drain } = makeCtx()
    const source = await loadSource()
    const result = await processOpsAlert(source, {
      severity: 'page', title: `sms fallback ${SUITE_ID}`,
    }, makeTestEnv(sent, []), ctx)
    await drain()

    expect(result.outcome).toBe('paged')
    const telnyx = sent.find((r) => r.url.includes('api.telnyx.com'))
    expect(telnyx).toBeTruthy()
    const row = await env.D1_US.prepare(
      `SELECT page_channel FROM ops_alerts WHERE id = ?`,
    ).bind(result.alertId).first<{ page_channel: string }>()
    expect(row?.page_channel).toBe('sms')
  })
})

describe('m4 — notice path + morning brief', () => {
  it('notice severity records without paging and surfaces in the ops section', async () => {
    const sent: SentRequest[] = []
    const queue: unknown[] = []
    stubFetch(sent)
    const { ctx, drain } = makeCtx()
    const source = await loadSource()
    const result = await processOpsAlert(source, {
      severity: 'notice', title: `deploy finished ${SUITE_ID}`,
    }, makeTestEnv(sent, queue), ctx)
    await drain()

    expect(result.outcome).toBe('noticed')
    expect(sent).toHaveLength(0) // no delivery calls at all
    expect(queue.some((m) => (m as { type: string }).type === 'retain_artifact')).toBe(true)

    const section = await fetchOpsSection(TENANT_ID, env as unknown as Env)
    expect(section).toContain('health spine: freshness unavailable') // no RO secret in tests
    expect(section).toContain(`deploy finished ${SUITE_ID}`)

    const row = await env.D1_US.prepare(
      `SELECT paged_at, brief_surfaced_at FROM ops_alerts WHERE id = ?`,
    ).bind(result.alertId).first<{ paged_at: number | null; brief_surfaced_at: number | null }>()
    expect(row?.paged_at).toBeNull()
    expect(row?.brief_surfaced_at).toBeTruthy()
  })
})
