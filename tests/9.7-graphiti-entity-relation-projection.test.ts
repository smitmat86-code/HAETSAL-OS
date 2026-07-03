import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { getCanonicalEntityTimeline, traceCanonicalRelationship } from '../src/services/canonical-graph-query'
import { prepareContextForAgent } from '../src/services/chief-of-staff-context'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import {
  createHindsightTestEnv,
  type HindsightCaptureState,
  type HindsightRecallRow,
} from './support/hindsight-test-env'
import { seedHistoricalHindsightProjection } from './support/historical-hindsight-seed'

type SeededCapture = {
  engineDocumentId: string
}

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-graphiti-97-${SUITE_ID}`
const leadershipNote: CanonicalPipelineCaptureInput = {
  tenantId: TENANT_ID,
  sourceSystem: 'mcp_retain',
  sourceRef: 'leadership-note',
  scope: 'general',
  title: 'Leadership update',
  body: 'Ava Stone leads Project Atlas for Northwind Labs.',
  capturedAt: Date.UTC(2026, 3, 20),
}
const partnershipNote: CanonicalPipelineCaptureInput = {
  tenantId: TENANT_ID,
  sourceSystem: 'mcp_retain',
  sourceRef: 'partnership-note',
  scope: 'general',
  title: 'Partnership update',
  body: 'Northwind Labs partnered with Blue River Studio on 2026-04-16.',
  capturedAt: Date.UTC(2026, 3, 20),
}
const meetingNote: CanonicalPipelineCaptureInput = {
  tenantId: TENANT_ID,
  sourceSystem: 'mcp_retain',
  sourceRef: 'meeting-note',
  scope: 'general',
  title: 'Meeting log',
  body: 'Ava Stone met with Ben Ortiz on 2026-04-15.',
  capturedAt: Date.UTC(2026, 3, 20),
}
const dependencyNote: CanonicalPipelineCaptureInput = {
  tenantId: TENANT_ID,
  sourceSystem: 'mcp_retain',
  sourceRef: 'dependency-note',
  scope: 'general',
  title: 'Dependency note',
  body: 'Project Atlas depends on Beacon API.',
  capturedAt: Date.UTC(2026, 3, 21),
}

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`graphiti-97-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('graphiti-97-salt'),
    info: new TextEncoder().encode('graphiti-97-info'),
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

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId: TENANT_ID,
    sourceRef: `${fixture.sourceRef}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createRuntimeEnv(args: {
  capture: HindsightCaptureState
  recallResults?: HindsightRecallRow[]
}) {
  const { testEnv, requests } = createGraphitiContainerTestEnv()
  return {
    requests,
    testEnv: {
      ...createHindsightTestEnv({
        capture: args.capture,
        operationStatus: 'completed',
        recallResults: args.recallResults ?? [],
      }),
      GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
      GRAPHITI: testEnv.GRAPHITI,
    } as typeof env,
  }
}

async function captureAndDispatch(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<SeededCapture> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, args.suffix, args.tmk)
  await captureThroughCanonicalPipeline({
    ...input,
    memoryType: 'episodic',
  }, args.testEnv, TENANT_ID)
  const pending: Promise<unknown>[] = []
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, args.testEnv, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  })
  await Promise.allSettled(pending)
  sendSpy.mockRestore()
  // Historical Hindsight projection: simulates a capture that was projected
  // to Hindsight before the write path was severed (mission Phase 1). The
  // pipeline can no longer produce these, so this is seeded directly for the
  // same body/scope/title as the real (graphiti) capture above.
  const seeded = await seedHistoricalHindsightProjection(args.testEnv, {
    tenantId: TENANT_ID,
    sourceSystem: args.fixture.sourceSystem,
    sourceRef: args.fixture.sourceRef ? `${args.fixture.sourceRef}-${args.suffix}` : null,
    scope: args.fixture.scope,
    title: args.fixture.title ?? null,
    body: args.fixture.body,
    capturedAt: args.fixture.capturedAt ?? null,
    tmk: args.tmk,
  })
  return {
    engineDocumentId: seeded.engineDocumentId,
  }
}

beforeAll(async () => {
  await ensureTenantWithKek()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('9.7 graphiti entity and relation projection', () => {
  it('projects leadership facts into body-derived person and project graph structure', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv, requests } = createRuntimeEnv({ capture: { retainCount: 0, operationIds: [] } })

    await captureAndDispatch({ fixture: leadershipNote, suffix: 'leadership', testEnv, tmk })

    const plan = requests[0]?.plan as {
      entities: Array<{ canonicalKey: string; kind: string }>
      edges: Array<{ relation: string; fromCanonicalKey: string; toCanonicalKey: string }>
    }
    const trace = await traceCanonicalRelationship({
      tenantId: TENANT_ID,
      from: 'Ava Stone',
      to: 'Project Atlas',
      relation: 'leads',
      limit: 5,
    }, testEnv, TENANT_ID)

    expect(plan.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalKey: 'canonical://people/ava-stone', kind: 'person' }),
      expect.objectContaining({ canonicalKey: 'canonical://projects/project-atlas', kind: 'project' }),
    ]))
    expect(plan.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: 'leads',
        fromCanonicalKey: 'canonical://people/ava-stone',
        toCanonicalKey: 'canonical://projects/project-atlas',
      }),
    ]))
    expect(trace.items[0]?.relation).toBe('leads')
    expect(trace.items[0]?.from.label).toBe('Ava Stone')
    expect(trace.items[0]?.to.label).toBe('Project Atlas')
  })

  it('projects partnership facts into graph-backed relationship traces', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv } = createRuntimeEnv({ capture: { retainCount: 0, operationIds: [] } })

    await captureAndDispatch({ fixture: partnershipNote, suffix: 'partnership', testEnv, tmk })

    const trace = await traceCanonicalRelationship({
      tenantId: TENANT_ID,
      from: 'Northwind Labs',
      to: 'Blue River Studio',
      relation: 'partnered_with',
      limit: 5,
    }, testEnv, TENANT_ID)

    expect(trace.items).toHaveLength(1)
    expect(trace.items[0]?.from.label).toBe('Northwind Labs')
    expect(trace.items[0]?.to.label).toBe('Blue River Studio')
    expect(trace.items[0]?.capturedAt).toBe(Date.UTC(2026, 3, 16))
  })

  it('projects meeting facts with explicit dates into entity timelines', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv } = createRuntimeEnv({ capture: { retainCount: 0, operationIds: [] } })

    await captureAndDispatch({ fixture: meetingNote, suffix: 'meeting', testEnv, tmk })

    const timeline = await getCanonicalEntityTimeline({
      tenantId: TENANT_ID,
      entity: 'Ava Stone',
      limit: 5,
      startAt: null,
      endAt: null,
    }, testEnv, TENANT_ID)

    expect(timeline.entityKey).toBe('canonical://people/ava-stone')
    expect(timeline.items[0]?.relation).toBe('met_with')
    expect(timeline.items[0]?.relatedEntity.label).toBe('Ben Ortiz')
    expect(timeline.items[0]?.capturedAt).toBe(Date.UTC(2026, 3, 15))
  })

  it('projects dependency facts into graph-backed dependency traces', async () => {
    const tmk = await deriveTestTmk()
    const { testEnv } = createRuntimeEnv({ capture: { retainCount: 0, operationIds: [] } })

    await captureAndDispatch({ fixture: dependencyNote, suffix: 'dependency', testEnv, tmk })

    const trace = await traceCanonicalRelationship({
      tenantId: TENANT_ID,
      from: 'Project Atlas',
      to: 'Beacon API',
      relation: 'depends_on',
      limit: 5,
    }, testEnv, TENANT_ID)

    expect(trace.items).toHaveLength(1)
    expect(trace.items[0]?.from.label).toBe('Project Atlas')
    expect(trace.items[0]?.to.label).toBe('Beacon Api')
  })

  it('lets prepare_context_for_agent incorporate graph-derived body facts for fresh captures', async () => {
    const tmk = await deriveTestTmk()
    const recallResults: HindsightRecallRow[] = []
    const { testEnv } = createRuntimeEnv({
      capture: { retainCount: 0, operationIds: [] },
      recallResults,
    })
    await captureAndDispatch({ fixture: dependencyNote, suffix: 'context-dependency', testEnv, tmk })
    const seeded = await captureAndDispatch({ fixture: leadershipNote, suffix: 'context-leadership', testEnv, tmk })
    recallResults.splice(0, recallResults.length, {
      document_id: seeded.engineDocumentId,
      text: 'Project Atlas has an active owner and still depends on Beacon API for the next rollout.',
      score: 0.97,
      tags: [`tenant:${TENANT_ID}`],
      metadata: { source: 'mcp_retain', domain: 'general' },
    })

    const bundle = await prepareContextForAgent({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Project Atlas',
      limit: 4,
      scope: null,
    }, testEnv, TENANT_ID, { tmk })

    expect(bundle.relationships.some(item => item.includes('depends on Beacon Api'))).toBe(true)
    expect(bundle.timeline.some(item => item.includes('Project Atlas'))).toBe(true)
    expect(bundle.sources.some(source => source.mode === 'graph' || source.mode === 'composed')).toBe(true)
    expect(bundle.evidence.some(block => block.mode === 'graph' && block.items.length > 0)).toBe(true)
  })
})
