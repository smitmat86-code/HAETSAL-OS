import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-canonical-71-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-hindsight-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-hindsight-salt'),
      info: new TextEncoder().encode('canonical-hindsight-info'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function ensureTenantWithKek(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
  const kekBytes = crypto.getRandomValues(new Uint8Array(32))
  await env.KV_SESSION.put(
    `cron_kek:${tenantId}`,
    btoa(String.fromCharCode(...kekBytes)),
    { expirationTtl: 60 * 60 * 24 },
  )
  await env.D1_US.prepare(
    `UPDATE tenants
     SET cron_kek_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now + (24 * 60 * 60 * 1000), now, tenantId).run()
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  tenantId: string,
  suffix: string,
): Promise<CanonicalPipelineCaptureInput> {
  const tmk = await deriveTestTmk()
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function makeHindsightEnv(options?: {
  failRetain?: boolean
  operationStatus?: 'pending' | 'completed' | 'failed'
  capture?: { retainCount: number; operationIds: string[] }
}) {
  return {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname) || /^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/documents\/[^/]+$/.test(url.pathname)) {
          return new Response(JSON.stringify({
            id: url.pathname.split('/').at(-1),
            bank_id: url.pathname.split('/')[4],
            memory_unit_count: 2,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(url.pathname)) {
          const operationId = url.pathname.split('/').at(-1)!
          const status = options?.operationStatus ?? 'pending'
          return new Response(JSON.stringify({
            operation_id: operationId,
            status,
            operation_type: 'retain',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: status === 'completed' || status === 'failed'
              ? new Date().toISOString()
              : null,
            error_message: status === 'failed' ? 'adapter submission failed' : null,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          if (options?.failRetain) {
            return new Response(JSON.stringify({ detail: 'retain failed' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as { items: Array<{ document_id: string }> }
          options?.capture && (options.capture.retainCount += 1)
          const operationId = `op-${body.items[0]!.document_id}`
          options?.capture?.operationIds.push(operationId)
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: true,
            operation_id: operationId,
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

async function processDispatch(
  message: { tenantId: string; payload: Record<string, unknown> },
  testEnv: typeof env,
): Promise<void> {
  const pending: Promise<unknown>[] = []
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, testEnv, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  })
  await Promise.allSettled(pending)
}

beforeAll(async () => {
  await ensureTenantWithKek(TENANT_A)
})

describe('7.1 hindsight projection adapter', () => {
  it('removes the inline compatibility retain bridge and keeps queue payloads metadata-only', async () => {
    const capture = { retainCount: 0, operationIds: [] as string[] }
    const testEnv = makeHindsightEnv({ capture, operationStatus: 'pending' })
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, TENANT_A, 'bridge-off')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_A)
    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )
    const queuedMessage = JSON.stringify(sendSpy.mock.calls[0]?.[0])

    expect(result.compatibility.status).toBe('queued')
    expect(capture.retainCount).toBe(0)
    expect(queuedMessage).not.toContain(input.body)
    expect(queuedMessage).not.toContain(input.bodyEncrypted!)
    expect(status.compatibility?.status).toBe('queued')
    expect(status.compatibility?.targetRef).toBeNull()

    const opsCount = await testEnv.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM hindsight_operations WHERE tenant_id = ? AND source_document_id = ?`,
    ).bind(TENANT_A, result.compatibility.documentId).first<{ count: number }>()
    expect(opsCount?.count).toBe(0)
  })

  it('submits and reconciles conversation captures through the real hindsight adapter', async () => {
    const capture = { retainCount: 0, operationIds: [] as string[] }
    const testEnv = makeHindsightEnv({ capture, operationStatus: 'completed' })
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(conversationFixture as CanonicalPipelineCaptureInput, TENANT_A, 'conversation')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'semantic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_A)
    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
    await processDispatch(message, testEnv)

    const latest = await testEnv.D1_US.prepare(
      `SELECT r.status, r.target_ref, r.engine_bank_id, r.engine_document_id, r.engine_operation_id
       FROM canonical_projection_results r
       INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
       WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
       ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
       LIMIT 1`,
    ).bind(TENANT_A, result.capture.operationId).first<{
      status: string
      target_ref: string | null
      engine_bank_id: string | null
      engine_document_id: string | null
      engine_operation_id: string | null
    }>()
    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )

    expect(capture.retainCount).toBe(1)
    expect(latest?.status).toBe('completed')
    expect(latest?.engine_bank_id).toBe(`hindsight-${TENANT_A}`)
    expect(latest?.engine_document_id).toContain(`${TENANT_A}:`)
    expect(latest?.engine_operation_id).toContain('op-')
    expect(latest?.target_ref).toContain('/documents/')
    expect(status.projections.find(item => item.kind === 'hindsight')?.status).toBe('completed')
    expect(status.compatibility?.status).toBe('retained')
  })

  it('marks hindsight projection failures honestly without losing canonical capture truth', async () => {
    const testEnv = makeHindsightEnv({ failRetain: true })
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, TENANT_A, 'failed')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_A)
    const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
    await processDispatch(message, testEnv)

    const latest = await testEnv.D1_US.prepare(
      `SELECT j.status AS job_status, r.status AS result_status, r.error_message
       FROM canonical_projection_jobs j
       LEFT JOIN canonical_projection_results r ON r.id = (
         SELECT r2.id
         FROM canonical_projection_results r2
         WHERE r2.projection_job_id = j.id
         ORDER BY r2.updated_at DESC, r2.created_at DESC, r2.id DESC
         LIMIT 1
       )
       WHERE j.tenant_id = ? AND j.operation_id = ? AND j.projection_kind = 'hindsight'
       LIMIT 1`,
    ).bind(TENANT_A, result.capture.operationId).first<{
      job_status: string
      result_status: string
      error_message: string | null
    }>()
    const captureRow = await testEnv.D1_US.prepare(
      `SELECT id FROM canonical_captures WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT_A, result.capture.captureId).first<{ id: string }>()
    const status = await getCanonicalMemoryStatus(
      { tenantId: TENANT_A, operationId: result.capture.operationId },
      testEnv,
      TENANT_A,
    )

    expect(captureRow?.id).toBe(result.capture.captureId)
    expect(latest?.job_status).toBe('failed')
    expect(latest?.result_status).toBe('failed')
    expect(latest?.error_message).toContain('retain failed')
    expect(status.compatibility?.status).toBe('failed')
  })
})
