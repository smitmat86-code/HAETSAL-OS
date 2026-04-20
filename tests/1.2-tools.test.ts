// tests/1.2-tools.test.ts
// Tool integration tests
// Verifies retain/recall return correct schema shapes
// Updated in Phase 2.1: retainStub -> retainViaService (real pipeline)

import { beforeEach, describe, it, expect, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { retainViaService } from '../src/tools/retain'
import { recallStub } from '../src/tools/recall'
import { createHindsightTestEnv } from './support/hindsight-test-env'

function makeToolEnv() {
  return {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: true,
            operation_id: 'op-test-retain',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  } as unknown as typeof env
}

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  await env.KV_SESSION.put(
    `cron_kek:${tenantId}`,
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    { expirationTtl: 60 * 60 * 24 },
  )
  await env.D1_US.prepare(
    `UPDATE tenants
     SET cron_kek_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('1.2 Tools - brain_v1_retain', () => {
  it('returns deferred status when TMK is null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await retainViaService(
      { content: 'Test memory content for retention', domain: 'career', memory_type: 'episodic' },
      'test-tenant',
      null,
      env,
    )
    expect(result.status).toBe('deferred')
    expect(result.memory_id).toBe('')
  })

  it('returns correct schema shape', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await retainViaService(
      { content: 'Short content' },
      'test-tenant',
      null,
      env,
    )
    expect(result).toHaveProperty('memory_id')
    expect(result).toHaveProperty('salience_tier')
    expect(result).toHaveProperty('status')
  })

  it('queues retain when TMK is available', async () => {
    await ensureTenantWithKek('test-tenant')
    const tmk = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    ) as CryptoKey
    const result = await retainViaService(
      { content: 'Queue this memory', domain: 'career', memory_type: 'episodic' },
      'test-tenant',
      tmk,
      makeToolEnv(),
    )
    expect(result.status).toBe('queued')
    expect(result.memory_id).toBeTruthy()
    expect(result.salience_tier).toBeGreaterThan(0)
  })

  it('eagerly hands off direct interactive writes to hindsight without waiting on the bulk queue', async () => {
    const tenantId = `test-tenant-eager-${crypto.randomUUID()}`
    await ensureTenantWithKek(tenantId)
    const tmk = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    ) as CryptoKey
    const testEnv = createHindsightTestEnv()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)

    const result = await retainViaService(
      {
        content: 'Interactive memory_write should reach hindsight handoff immediately.',
        domain: 'general',
        memory_type: 'episodic',
        source: 'mcp:memory_write',
      },
      tenantId,
      tmk,
      testEnv,
    )

    const row = await testEnv.D1_US.prepare(
      `SELECT r.engine_document_id, r.engine_operation_id, r.status
       FROM canonical_projection_jobs j
       INNER JOIN canonical_projection_results r ON r.id = (
         SELECT r2.id
         FROM canonical_projection_results r2
         WHERE r2.projection_job_id = j.id
         ORDER BY r2.updated_at DESC, r2.created_at DESC, r2.id DESC
         LIMIT 1
       )
       WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
       LIMIT 1`,
    ).bind(tenantId, result.canonical_operation_id).first<{
      engine_document_id: string | null
      engine_operation_id: string | null
      status: string
    }>()

    expect(sendSpy).toHaveBeenCalled()
    expect(result.status).toBe('queued')
    expect(result.canonical_operation_id).toBeTruthy()
    expect(['queued', 'completed']).toContain(row?.status)
    expect(row?.engine_document_id).toBeTruthy()
    expect(row?.engine_operation_id).toContain('op-')
  })
})

describe('1.2 Tools - brain_v1_recall stub', () => {
  it('returns correct schema with results and synthesis', async () => {
    const result = await recallStub({
      query: 'What did I learn about TypeScript?',
      domain: 'career',
    })
    expect(result.results).toBeInstanceOf(Array)
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0]).toHaveProperty('memory_id')
    expect(result.results[0]).toHaveProperty('content')
    expect(result.results[0]).toHaveProperty('memory_type')
    expect(result.results[0]).toHaveProperty('confidence')
    expect(result.results[0]).toHaveProperty('relevance')
    expect(result.synthesis).toBeTruthy()
  })

  it('synthesis indicates stub status', async () => {
    const result = await recallStub({ query: 'test' })
    expect(result.synthesis).toContain('Stub')
  })
})
