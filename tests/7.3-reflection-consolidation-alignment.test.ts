import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import {
  completeCanonicalHindsightReflectionRun,
  failCanonicalHindsightReflectionRun,
  startCanonicalHindsightReflectionRun,
} from '../src/services/canonical-hindsight-reflection'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import type { CanonicalMemoryStatusResult } from '../src/types/canonical-memory-query'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import noteFixture from './fixtures/canonical-memory/note-capture.json'

const consolidationMocks = vi.hoisted(() => ({
  fetchAndValidateKek: vi.fn<() => Promise<CryptoKey | null>>(),
  runPass1: vi.fn<() => Promise<number>>(),
  runPass2: vi.fn<() => Promise<number>>(),
  runPass3: vi.fn<() => Promise<number>>(),
  runPass4: vi.fn<() => Promise<number>>(),
}))

vi.mock('../src/cron/kek', () => ({
  fetchAndValidateKek: consolidationMocks.fetchAndValidateKek,
}))

vi.mock('../src/cron/passes/pass1-contradiction', () => ({
  runPass1: consolidationMocks.runPass1,
}))

vi.mock('../src/cron/passes/pass2-bridges', () => ({
  runPass2: consolidationMocks.runPass2,
}))

vi.mock('../src/cron/passes/pass3-patterns', () => ({
  runPass3: consolidationMocks.runPass3,
}))

vi.mock('../src/cron/passes/pass4-gaps', () => ({
  runPass4: consolidationMocks.runPass4,
}))

const { runConsolidationPasses } = await import('../src/cron/consolidation')

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-canonical-73-${SUITE_ID}`
const HINDSIGHT_BANK_ID = `hindsight-${TENANT_A}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`canonical-reflection-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('canonical-reflection-salt'),
      info: new TextEncoder().encode('canonical-reflection-info'),
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
  ).bind(tenantId, now, now, HINDSIGHT_BANK_ID, now).run()

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

async function resetTenantState(tenantId: string): Promise<void> {
  await env.D1_US.exec([
    `DELETE FROM consolidation_gaps WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM consolidation_runs WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_graph_identity_mappings WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_projection_results WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_projection_jobs WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_memory_operations WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_chunks WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_documents WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_artifacts WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM canonical_captures WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM hindsight_operations WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM ingestion_events WHERE tenant_id = '${tenantId}'`,
    `DELETE FROM memory_audit WHERE tenant_id = '${tenantId}'`,
  ].join(';\n'))
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  tenantId: string,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createHindsightEnv(state: {
  operationStatus: 'pending' | 'completed' | 'failed'
  retainCount: number
}): typeof env {
  const { testEnv } = createGraphitiContainerTestEnv()
  return {
    ...env,
    GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: testEnv.GRAPHITI,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname) || /^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return Response.json({ items: [] })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(url.pathname)) {
          const operationId = url.pathname.split('/').at(-1)
          return Response.json({
            operation_id: operationId,
            status: state.operationStatus,
            operation_type: 'retain',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: state.operationStatus === 'pending' ? null : new Date().toISOString(),
            error_message: state.operationStatus === 'failed' ? 'projection failed' : null,
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          const request = input instanceof Request ? input : new Request(input.toString(), init)
          const body = await request.clone().json() as { items: Array<{ document_id: string }> }
          state.retainCount += 1
          return Response.json({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: true,
            operation_id: `op-${body.items[0]!.document_id}`,
          })
        }
        return Response.json({ status: 'ok' })
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

async function captureAndProject(args: {
  suffix: string
  testEnv: typeof env
  tmk: CryptoKey
  bodySuffix?: string
}): Promise<{ captureId: string; documentId: string; operationId: string; body: string }> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const fixture = {
    ...(noteFixture as CanonicalPipelineCaptureInput),
    body: `${(noteFixture as CanonicalPipelineCaptureInput).body}${args.bodySuffix ? ` ${args.bodySuffix}` : ''}`,
  }
  const input = await encryptFixture(fixture, TENANT_A, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({
    ...input,
    memoryType: 'episodic',
    compatibilityMode: 'current_hindsight',
  }, args.testEnv, TENANT_A)

  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processDispatch(message, args.testEnv)
  sendSpy.mockRestore()

  return {
    captureId: result.capture.captureId,
    documentId: result.capture.documentId,
    operationId: result.capture.operationId,
    body: fixture.body,
  }
}

async function readStatus(
  testEnv: typeof env,
  operationId: string,
): Promise<CanonicalMemoryStatusResult> {
  return getCanonicalMemoryStatus(
    { tenantId: TENANT_A, operationId },
    testEnv,
    TENANT_A,
  )
}

beforeAll(async () => {
  await ensureTenantWithKek(TENANT_A)
})

beforeEach(async () => {
  vi.restoreAllMocks()
  consolidationMocks.fetchAndValidateKek.mockResolvedValue({} as CryptoKey)
  consolidationMocks.runPass1.mockResolvedValue(1)
  consolidationMocks.runPass2.mockResolvedValue(2)
  consolidationMocks.runPass3.mockResolvedValue(3)
  consolidationMocks.runPass4.mockResolvedValue(4)
  await resetTenantState(TENANT_A)
})

describe('7.3 reflection / consolidation alignment', () => {
  it('extends canonical memory status from pending reflection to completed reflection through the existing consolidation runner', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createHindsightEnv({ operationStatus: 'completed', retainCount: 0 })
    const seeded = await captureAndProject({
      suffix: 'reflection-complete',
      testEnv,
      tmk,
      bodySuffix: 'ReflectionStatusNeedle',
    })

    const before = await readStatus(testEnv, seeded.operationId)
    expect(before.reflection?.status).toBe('pending')
    expect(before.operation.status).toBe('completed')
    expect(before.projections.find(item => item.kind === 'hindsight')?.semanticReady).toBe(true)

    await runConsolidationPasses(HINDSIGHT_BANK_ID, testEnv, {
      waitUntil() {},
    } as ExecutionContext)

    const reflectionAudit = await testEnv.D1_US.prepare(
      `SELECT operation, memory_id
       FROM memory_audit
       WHERE tenant_id = ? AND memory_id = ? AND operation LIKE 'memory.projection.hindsight_reflect_%'
       ORDER BY created_at ASC, id ASC`,
    ).bind(TENANT_A, seeded.operationId).all<{ operation: string; memory_id: string }>()
    expect(reflectionAudit.results).toHaveLength(2)
    expect(reflectionAudit.results?.map(row => row.operation)).toEqual(expect.arrayContaining([
      'memory.projection.hindsight_reflect_started',
      'memory.projection.hindsight_reflect_completed',
    ]))
    expect(JSON.stringify(reflectionAudit.results ?? [])).not.toContain('ReflectionStatusNeedle')

    const after = await readStatus(testEnv, seeded.operationId)
    expect(after.reflection?.status).toBe('completed')
    expect(after.reflection?.updatedAt).toEqual(expect.any(Number))
    expect(after.reflection?.targetRef).toContain('/consolidation-runs/')

    const run = await testEnv.D1_US.prepare(
      `SELECT status, pass1_contradictions, pass2_bridges, pass3_patterns, pass4_gaps
       FROM consolidation_runs
       WHERE tenant_id = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    ).bind(TENANT_A).first<{
      status: string
      pass1_contradictions: number
      pass2_bridges: number
      pass3_patterns: number
      pass4_gaps: number
    }>()
    expect(run?.status).toBe('completed')
    expect(run?.pass1_contradictions).toBe(1)
    expect(run?.pass2_bridges).toBe(2)
    expect(run?.pass3_patterns).toBe(3)
    expect(run?.pass4_gaps).toBe(4)
  })

  it('keeps failed and retried reflection states distinguishable and truthful', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createHindsightEnv({ operationStatus: 'completed', retainCount: 0 })
    const seeded = await captureAndProject({
      suffix: 'reflection-retry',
      testEnv,
      tmk,
    })

    const firstRun = await startCanonicalHindsightReflectionRun({
      env: testEnv,
      tenantId: TENANT_A,
      bankId: HINDSIGHT_BANK_ID,
      runId: 'reflection-run-failed',
    })
    expect((await readStatus(testEnv, seeded.operationId)).reflection?.status).toBe('queued')

    await failCanonicalHindsightReflectionRun(firstRun, testEnv)
    expect((await readStatus(testEnv, seeded.operationId)).reflection?.status).toBe('failed')

    const retryRun = await startCanonicalHindsightReflectionRun({
      env: testEnv,
      tenantId: TENANT_A,
      bankId: HINDSIGHT_BANK_ID,
      runId: 'reflection-run-retry',
    })
    await completeCanonicalHindsightReflectionRun(retryRun, testEnv)

    const afterRetry = await readStatus(testEnv, seeded.operationId)
    expect(afterRetry.reflection?.status).toBe('completed')

    const reflectionAudit = await testEnv.D1_US.prepare(
      `SELECT operation
       FROM memory_audit
       WHERE tenant_id = ? AND memory_id = ? AND operation LIKE 'memory.projection.hindsight_reflect_%'
       ORDER BY created_at ASC, id ASC`,
    ).bind(TENANT_A, seeded.operationId).all<{ operation: string }>()
    const actions = reflectionAudit.results?.map(row => row.operation) ?? []
    expect(actions).toHaveLength(4)
    expect(actions.filter(action => action === 'memory.projection.hindsight_reflect_started')).toHaveLength(2)
    expect(actions.filter(action => action === 'memory.projection.hindsight_reflect_failed')).toHaveLength(1)
    expect(actions.filter(action => action === 'memory.projection.hindsight_reflect_completed')).toHaveLength(1)
  })

  it('keeps reflection null until the semantic projection itself is actually complete', async () => {
    const tmk = await deriveTestTmk()
    const testEnv = createHindsightEnv({ operationStatus: 'pending', retainCount: 0 })
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, TENANT_A, 'still-queued', tmk)
    const result = await captureThroughCanonicalPipeline({
      ...input,
      memoryType: 'episodic',
      compatibilityMode: 'current_hindsight',
    }, testEnv, TENANT_A)
    sendSpy.mockRestore()

    const status = await readStatus(testEnv, result.capture.operationId)
    expect(status.operation.status).toBe('queued')
    expect(status.reflection).toBeNull()
  })
})
