import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalMemoryStore, installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-projection-policy-117-${SUITE_ID}`

installCanonicalMemoryTestStore(env)

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`projection-policy-${SUITE_ID}`),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('projection-policy-salt'),
      info: new TextEncoder().encode('projection-policy-info'),
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

async function makeInput(suffix: string): Promise<CanonicalPipelineCaptureInput> {
  const tmk = await deriveTestTmk()
  const body = [
    `Projection policy fixture ${suffix}.`,
    'Ava Stone leads Project Atlas and wants graph truth without Hindsight projection side effects.',
  ].join('\n')
  return {
    tenantId: TENANT_ID,
    sourceSystem: 'notes',
    sourceRef: `projection-policy-${suffix}`,
    scope: 'projects',
    title: `Projection policy ${suffix}`,
    body,
    bodyEncrypted: await encryptContentForArchive(body, tmk),
    capturedAt: Date.UTC(2026, 5, 4),
    memoryType: 'episodic',
  }
}

function createPolicyTestEnv() {
  const { requests, testEnv } = createGraphitiContainerTestEnv()
  const hindsightFetch = vi.fn(async () => {
    throw new Error('Hindsight dispatch should not run: write path severed in mission Phase 1')
  })
  return {
    requests,
    hindsightFetch,
    testEnv: {
      ...testEnv,
      HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
      WORKER_DOMAIN: 'haetsalos.test',
      HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
      HINDSIGHT: { fetch: hindsightFetch },
    } as typeof env,
  }
}

function hindsightPayloadKey(captureId: string): string {
  return `canonical/${TENANT_ID}/projections/hindsight/${captureId}.enc`
}

function graphitiPayloadKey(captureId: string): string {
  return `canonical/${TENANT_ID}/projections/graphiti/${captureId}.enc`
}

beforeAll(async () => {
  await ensureTenantWithKek(TENANT_ID)
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('11.7 post-Hindsight projection policy surface (Phase 1 severed)', () => {
  it('defaults to graphiti-only projection when projectionKinds is omitted', async () => {
    const { hindsightFetch, testEnv } = createPolicyTestEnv()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await makeInput('default')

    const result = await captureThroughCanonicalPipeline(input, testEnv, TENANT_ID)
    const jobs = await getCanonicalMemoryStore(testEnv)
      .listProjectionJobsForOperation(TENANT_ID, result.capture.operationId)
    const message = sendSpy.mock.calls[0]?.[0] as { payload: { projectionKinds: string[] } }

    expect(result.capture.projectionKinds).toEqual(['graphiti'])
    expect(message.payload.projectionKinds).toEqual(['graphiti'])
    expect(jobs.map(job => job.projection_kind)).toEqual(['graphiti'])
    expect(await testEnv.R2_ARTIFACTS.get(graphitiPayloadKey(result.capture.captureId))).toBeTruthy()
    expect(await testEnv.R2_ARTIFACTS.get(hindsightPayloadKey(result.capture.captureId))).toBeNull()
    expect('compatibility' in result).toBe(false)
    expect(hindsightFetch).not.toHaveBeenCalled()
  })

  it('rejects an explicit hindsight projection request as retired', async () => {
    const { hindsightFetch, testEnv } = createPolicyTestEnv()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await makeInput('hindsight-rejected')

    await expect(captureThroughCanonicalPipeline({
      ...input,
      projectionKinds: ['hindsight'],
    }, testEnv, TENANT_ID)).rejects.toThrow(/Hindsight projections are retired/)
    expect(hindsightFetch).not.toHaveBeenCalled()
  })

  it('creates only graphiti projection jobs when projectionKinds selects graphiti', async () => {
    const { testEnv } = createPolicyTestEnv()
    const sendSpy = vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await makeInput('graphiti-only-jobs')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      projectionKinds: ['graphiti'],
    }, testEnv, TENANT_ID)
    const jobs = await getCanonicalMemoryStore(testEnv)
      .listProjectionJobsForOperation(TENANT_ID, result.capture.operationId)
    const message = sendSpy.mock.calls[0]?.[0] as { payload: { projectionKinds: string[] } }

    expect(result.capture.projectionKinds).toEqual(['graphiti'])
    expect(message.payload.projectionKinds).toEqual(['graphiti'])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.projection_kind).toBe('graphiti')
    expect(await testEnv.R2_ARTIFACTS.get(graphitiPayloadKey(result.capture.captureId))).toBeTruthy()
    expect(await testEnv.R2_ARTIFACTS.get(hindsightPayloadKey(result.capture.captureId))).toBeNull()
  })

  it('does not materialize or dispatch Hindsight when eager dispatch is requested', async () => {
    const { hindsightFetch, requests, testEnv } = createPolicyTestEnv()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await makeInput('eager-graphiti-only')

    const result = await captureThroughCanonicalPipeline({
      ...input,
      eagerProjectionDispatch: true,
    }, testEnv, TENANT_ID)
    const store = getCanonicalMemoryStore(testEnv)
    const graphitiProjection = await store
      .getLatestProjectionResultForOperation(TENANT_ID, result.capture.operationId, 'graphiti')
    const hindsightProjection = await store
      .getLatestProjectionResultForOperation(TENANT_ID, result.capture.operationId, 'hindsight')

    expect(hindsightFetch).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.captureId).toBe(result.capture.captureId)
    expect(graphitiProjection?.status).toBe('completed')
    expect(hindsightProjection).toBeNull()
    expect(await testEnv.R2_ARTIFACTS.get(graphitiPayloadKey(result.capture.captureId))).toBeTruthy()
    expect(await testEnv.R2_ARTIFACTS.get(hindsightPayloadKey(result.capture.captureId))).toBeNull()
  })
})
