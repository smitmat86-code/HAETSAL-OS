import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  CanonicalDocumentResult,
  CanonicalRecentResult,
  CanonicalSearchResult,
} from '../src/types/canonical-memory-query'
import { EXTERNAL_BRAIN_SURFACES, getExternalBrainSurface } from '../src/services/external-brain-contract'
import {
  captureDriveDocumentSourceRead,
  captureRecentCalendarEventWindow,
  captureRecentGmailThreadWindow,
} from '../src/services/google-source-read'
import { GOOGLE_SOURCE_READ_PROFILE } from '../src/services/google-source-read-contract'
import { registerCanonicalMemoryTools } from '../src/tools/canonical-memory'

type ToolResponse = { content: Array<{ text: string }> }
type ToolHandler = (input: unknown) => Promise<ToolResponse>
type ToolRegistry = { handlers: Map<string, ToolHandler>; pending: Promise<unknown>[] }

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-google-source-read-95-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`google-source-read-95-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('google-source-read-95-salt'),
    info: new TextEncoder().encode('google-source-read-95-info'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function ensureTenantWithKek(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT_ID, now, now, `hindsight-${TENANT_ID}`, now).run()
  await env.KV_SESSION.put(`cron_kek:${TENANT_ID}`, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), { expirationTtl: 60 * 60 * 24 })
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now + (24 * 60 * 60 * 1000), now, TENANT_ID).run()
}

function makeEnvWithHindsightStub() {
  return {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname) || /^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as { async?: boolean }
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: body.async ?? false,
            operation_id: body.async ? `op-${crypto.randomUUID()}` : undefined,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    },
  } as unknown as typeof env
}

function createToolRegistry(testEnv: typeof env, tmk: CryptoKey | null): ToolRegistry {
  const handlers = new Map<string, ToolHandler>()
  const pending: Promise<unknown>[] = []
  const server = { tool(name: string, _description: string, _shape: object, handler: ToolHandler) { handlers.set(name, handler) } } as unknown as McpServer
  registerCanonicalMemoryTools(server, {
    getEnv: () => testEnv,
    getTenantId: () => TENANT_ID,
    getTmk: () => tmk,
    getExecutionContext: () => ({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } }),
  })
  return { handlers, pending }
}

async function callTool<T>(registry: ToolRegistry, name: string, input: unknown = {}): Promise<T> {
  const response = await registry.handlers.get(name)?.(input)
  await Promise.allSettled(registry.pending.splice(0))
  return JSON.parse(response?.content[0]?.text ?? 'null') as T
}

function googleResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeAll(async () => { await ensureTenantWithKek() })
beforeEach(() => { vi.restoreAllMocks() })

describe('9.5 google source-read ingestion rollout', () => {
  it('captures Gmail, Calendar, and explicit-inclusion Drive/Docs with provenance-rich source refs', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = makeEnvWithHindsightStub()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/gmail/v1/users/me/threads?')) return googleResponse({ threads: [{ id: 'thread-95' }] })
      if (url.includes('/gmail/v1/users/me/threads/thread-95?format=full')) {
        return googleResponse({
          id: 'thread-95',
          historyId: 'history-95',
          messages: [
            {
              id: 'msg-1',
              threadId: 'thread-95',
              internalDate: String(Date.now() - 3600_000),
              payload: {
                headers: [{ name: 'From', value: 'lead@example.com' }, { name: 'Subject', value: 'Roadmap' }],
                body: { data: btoa('We should retain the roadmap decision and next steps.') },
              },
            },
            {
              id: 'msg-2',
              threadId: 'thread-95',
              internalDate: String(Date.now()),
              payload: {
                headers: [{ name: 'From', value: 'matth@example.com' }, { name: 'Subject', value: 'Roadmap' }],
                body: { data: btoa('Agreed. Keep Google under brain-sources-read only.') },
              },
            },
          ],
        })
      }
      if (url.includes('/calendar/v3/calendars/primary/events?')) return googleResponse({ items: [{ id: 'event-95' }] })
      if (url.includes('/calendar/v3/calendars/primary/events/event-95')) {
        const start = new Date(Date.now() + 3600_000).toISOString()
        const end = new Date(Date.now() + 7200_000).toISOString()
        return googleResponse({
          id: 'event-95',
          summary: 'Product review',
          description: 'Review the selective Google rollout.',
          start: { dateTime: start },
          end: { dateTime: end },
          attendees: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
          htmlLink: 'https://calendar.google.com/event?eid=event-95',
        })
      }
      if (url.includes('/drive/v3/files/doc-95/export?')) {
        return new Response(`---
title: Google rollout note
brain: true
domain: research
---
Capture this document into the brain.
Link it to [[Selective Ingestion]] and [[Canonical Provenance]].`, { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const gmail = await captureRecentGmailThreadWindow({
      tenantId: TENANT_ID,
      accessToken: 'gmail-token',
      tmk,
      env: testEnv,
      ctx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
      maxThreads: 3,
    })
    const calendar = await captureRecentCalendarEventWindow({
      tenantId: TENANT_ID,
      accessToken: 'calendar-token',
      tmk,
      env: testEnv,
      ctx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
      updatedSinceMs: Date.now() - 3600_000,
      maxEvents: 3,
    })
    const drive = await captureDriveDocumentSourceRead({
      tenantId: TENANT_ID,
      file: {
        id: 'doc-95',
        name: 'google-rollout-note.md',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: new Date().toISOString(),
      },
      accessToken: 'drive-token',
      inclusionReason: '/to-brain/',
      tmk,
      env: testEnv,
      ctx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    })

    expect(gmail).toBe(1)
    expect(calendar).toBe(1)
    expect(drive?.canonicalDocumentId).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalled()

    const registry = createToolRegistry(testEnv, tmk)
    const search = await callTool<CanonicalSearchResult>(registry, 'search_memory', {
      query: 'selective Google rollout',
      limit: 10,
    })
    const recent = await callTool<CanonicalRecentResult>(registry, 'get_recent_memories', { limit: 10 })
    const document = await callTool<CanonicalDocumentResult>(registry, 'get_document', {
      document_id: drive?.canonicalDocumentId,
    })

    expect(search.items.some((item) => item.googleSource?.kind === 'gmail' && item.googleSource?.sourceId === 'thread-95')).toBe(true)
    expect(search.items.some((item) => item.googleSource?.kind === 'calendar' && item.googleSource?.sourceId === 'event-95')).toBe(true)
    expect(recent.items.some((item) => item.googleSource?.kind === 'drive' && item.googleSource?.explicitInclusion)).toBe(true)
    expect(document.googleSource?.kind).toBe('drive')
    expect(document.googleSource?.explicitInclusion).toBe(true)
    expect(document.artifact?.storageKind).toBe('reference')
    expect(document.artifact?.storageKey).toContain('drive.google.com/file/d/doc-95/view')
    expect(document.brainMemory).toBeFalsy()
  })

  it('keeps Google under brain-sources-read and explicitly read-only', () => {
    const sourceRead = getExternalBrainSurface('brain-sources-read')

    expect(GOOGLE_SOURCE_READ_PROFILE.surface).toBe('brain-sources-read')
    expect(GOOGLE_SOURCE_READ_PROFILE.canReadGmail).toBe(true)
    expect(GOOGLE_SOURCE_READ_PROFILE.canReadCalendar).toBe(true)
    expect(GOOGLE_SOURCE_READ_PROFILE.canReadDrive).toBe(true)
    expect(GOOGLE_SOURCE_READ_PROFILE.canWriteGoogle).toBe(false)
    expect(GOOGLE_SOURCE_READ_PROFILE.rejectsNaiveMirroring).toBe(true)
    expect(sourceRead.status).toBe('live')
    expect(sourceRead.operations.every((operation) => operation.actionClass === 'source-read')).toBe(true)
    expect(sourceRead.operations.every((operation) => !operation.id.includes('send') && !operation.id.includes('create') && !operation.id.includes('edit'))).toBe(true)
    expect(EXTERNAL_BRAIN_SURFACES.some((surface) => surface.id === 'brain-actions' && surface.status === 'deferred')).toBe(true)
  })
})
