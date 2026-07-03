// Mission Phase 5: real action executors — web search (Brave), internal drafts
// (canonical capture), and channel send routing. Verifies capability-class
// routing, the S5 Gmail boundary (honest failure, no silent stub), and that
// draft/search produce the right execution results.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { dispatchTool } from '../src/services/action/tool-dispatch'
import { executeSendMessage, GmailNotConnectedError } from '../src/services/action/integrations/messaging'
import { executeDraft } from '../src/services/action/integrations/drafts'
import { searchStub } from '../src/tools/act/search'
import { draftStub } from '../src/tools/act/draft'
import { sendMessageStub } from '../src/tools/act/send-message'
import { getCanonicalMemoryStore, installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import type { ActionQueueMessage } from '../src/types/action'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-50-${SUITE}`

installCanonicalMemoryTestStore(env)

async function deriveTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m50-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m50'), info: new TextEncoder().encode('m50') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    BRAVE_API_KEY: 'test-brave-key',
    SENDBLUE_API_KEY_ID: 'k', SENDBLUE_API_SECRET_KEY: 's', SENDBLUE_PHONE_NUMBER: '+16452067656',
    TELEGRAM_BOT_TOKEN: 't',
    ...overrides,
  } as unknown as Env
}

const noopCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function msg(overrides: Partial<ActionQueueMessage>): ActionQueueMessage {
  return {
    action_id: crypto.randomUUID(), tenant_id: TENANT, proposed_by: 'mcpagent/tool',
    tool_name: 'brain_v1_act_search', capability_class: 'READ', integration: 'web',
    payload_r2_key: `actions/${TENANT}/x`, payload_hash: '', payload_stub: '{}',
    ...overrides,
  }
}

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
})

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mission 5.0 — capability-class routing (tool stubs)', () => {
  const queue: unknown[] = []
  const stubEnv = { QUEUE_ACTIONS: { send: async (m: unknown) => { queue.push(m) } } }
  beforeEach(() => { queue.length = 0 })

  it('search is READ, draft is WRITE_INTERNAL, send_message is IRREVERSIBLE', async () => {
    await searchStub({ query: 'x' }, stubEnv as never, TENANT, 'agent')
    await draftStub({ title: 't', content: 'c' }, stubEnv as never, TENANT, 'agent')
    await sendMessageStub({ recipient: '+1', message: 'm' }, stubEnv as never, TENANT, 'agent')
    const classes = (queue as ActionQueueMessage[]).map((m) => m.capability_class)
    expect(classes).toEqual(['READ', 'WRITE_INTERNAL', 'WRITE_EXTERNAL_IRREVERSIBLE'])
  })
})

describe('mission 5.0 — web search executor', () => {
  it('calls Brave with the subscription header and summarizes hits', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: input.toString(), headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({ web: { results: [
        { title: 'Atlas kickoff notes', url: 'https://a', description: 'x' },
        { title: 'Second result', url: 'https://b', description: 'y' },
      ] } }), { status: 200 })
    })
    const result = await dispatchTool(
      msg({ tool_name: 'brain_v1_act_search', payload_stub: JSON.stringify({ query: 'atlas' }) }),
      null, makeEnv(), noopCtx,
    )
    expect(result).not.toBe('stub')
    expect((result as { resultSummary: string }).resultSummary).toContain('2 hits')
    expect((result as { resultSummary: string }).resultSummary).toContain('Atlas kickoff notes')
    expect(seen[0].url).toContain('api.search.brave.com')
    expect(seen[0].headers['X-Subscription-Token']).toBe('test-brave-key')
  })
})

describe('mission 5.0 — internal draft executor', () => {
  it('captures a note draft to canonical memory and returns a draft id', async () => {
    const tmk = await deriveTmk()
    const result = await dispatchTool(
      msg({ tool_name: 'brain_v1_act_draft', capability_class: 'WRITE_INTERNAL',
        payload_stub: JSON.stringify({ title: 'Plan', content: 'Ship Phase 5', draft_type: 'note' }) }),
      tmk, makeEnv(), noopCtx,
    )
    expect((result as { resultSummary: string }).resultSummary).toContain('drafted:note')

    const store = getCanonicalMemoryStore(makeEnv())
    const docs = await store.listRecentDocuments(TENANT, null, 5)
    const capture = await store.getCapture(TENANT, docs[0]!.capture_id)
    expect(capture?.provenance_note).toBe('draft')
    expect(capture?.author_kind).toBe('user')
    expect(capture?.memory_class).toBe('episode')
  })
})

describe('mission 5.0 — S5 Gmail boundary (honest failure, no silent stub)', () => {
  it('send_message to an email throws GmailNotConnectedError', async () => {
    await expect(executeSendMessage({ recipient: 'a@b.com', message: 'hi', channel: 'email' }, makeEnv()))
      .rejects.toBeInstanceOf(GmailNotConnectedError)
  })
  it('draft of type email throws GmailNotConnectedError', async () => {
    const tmk = await deriveTmk()
    await expect(executeDraft({ title: 't', content: 'c', draft_type: 'email' }, TENANT, tmk, makeEnv()))
      .rejects.toBeInstanceOf(GmailNotConnectedError)
  })
})

describe('mission 5.0 — channel send routing', () => {
  it('routes an imessage recipient to Sendblue and reports delivered', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      expect(input.toString()).toContain('api.sendblue.co')
      return new Response(JSON.stringify({ status: 'QUEUED' }), { status: 200 })
    })
    const result = await executeSendMessage(
      { recipient: '+19515225229', message: 'hi', channel: 'imessage' }, makeEnv(),
    )
    expect(result).toMatchObject({ channel: 'imessage', delivered: true, detail: 'sendblue' })
  })
})
