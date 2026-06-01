import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { captureCanonicalMemory } from '../src/services/canonical-memory'
import { loadCompiledChiefOfStaffContext } from '../src/services/chief-of-staff-compiled-context'
import { prepareContextForAgent } from '../src/services/chief-of-staff-context'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import * as compiledSynthesis from '../src/services/compiled-synthesis'
import { compileProjectSynthesisFromCanonicalTruth, persistCompiledSynthesis } from '../src/services/compiled-synthesis'
import { getCompiledSynthesisStore, installCompiledSynthesisTestStore } from '../src/services/compiled-synthesis-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { getOrCreateTenant } from '../src/services/tenant'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'
import { createHindsightTestEnv, type HindsightCaptureState, type HindsightRecallRow } from './support/hindsight-test-env'
import type {
  CompiledChangeViewReadModel,
  CompiledContextPackReadModel,
  CompiledDossierReadModel,
} from '../src/services/compiled-synthesis'

type SeededCapture = {
  captureId: string
  documentId: string
  operationId: string
  engineDocumentId: string
}

const SUITE_ID = crypto.randomUUID()
const TENANT_PREFIX = `test-tenant-chief-113-${SUITE_ID}`
const FALLBACK_TENANT_ID = `${TENANT_PREFIX}-fallback`
const projectNote: CanonicalPipelineCaptureInput = { tenantId: FALLBACK_TENANT_ID, sourceSystem: 'mcp_retain', sourceRef: 'launch-note', scope: 'general', title: 'Launch plan', body: 'Launch plan now runs through three milestones. Risk: the operations checklist still needs an owner before launch.', capturedAt: 1760280000000 }
const projectConversation: CanonicalPipelineCaptureInput = { tenantId: FALLBACK_TENANT_ID, sourceSystem: 'mcp_memory_write', sourceRef: 'launch-conversation', scope: 'general', title: 'Launch plan', body: 'User: We removed the optional work from the critical path.\nAssistant: Captured. Recent change: only the three launch milestones remain, and the checklist owner is still unresolved.', capturedAt: 1760366400000 }
const projectGraphNote: CanonicalPipelineCaptureInput = { tenantId: FALLBACK_TENANT_ID, sourceSystem: 'mcp_retain', sourceRef: 'launch-graph', scope: 'general', title: 'Launch plan', body: 'Launch Plan depends on Operations Checklist.', capturedAt: 1760323200000 }

installCanonicalMemoryTestStore(env)
installCompiledSynthesisTestStore(env)

async function createTmk(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

async function deriveFallbackTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`context-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('context-salt'), info: new TextEncoder().encode('context-info') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptForTest(content: string, tmk: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(content)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tmk, data)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function ensureFallbackTenantWithKek(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(`INSERT OR IGNORE INTO tenants (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at) VALUES (?, ?, ?, 'us', 'sms', ?, ?)`).bind(FALLBACK_TENANT_ID, now, now, `hindsight-${FALLBACK_TENANT_ID}`, now).run()
  await env.KV_SESSION.put(`cron_kek:${FALLBACK_TENANT_ID}`, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), { expirationTtl: 60 * 60 * 24 })
  await env.D1_US.prepare(`UPDATE tenants SET cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`).bind(now + (24 * 60 * 60 * 1000), now, FALLBACK_TENANT_ID).run()
}

async function seedAuroraCanonicalTruth(
  tenantId: string,
  tmk: CryptoKey,
): Promise<Array<{ captureId: string; documentId: string }>> {
  const bodies = [
    [
      'Why It Matters: Aurora Anchor governs the billing migration and weekly launch decisions.',
      'Current State: Billing cutover is active, but vendor signoff still gates launch.',
      'Facts:',
      '- status | Project status is yellow until Nimbus Ledger signs off.',
      '- staffing_risk | Staffing remains compressed for the accelerated launch window.',
      'Relationships:',
      '- depends_on | Nimbus Ledger | Nimbus Ledger controls the billing signoff gate.',
      'Changes:',
      '- schedule_change | Leadership moved the target launch up by one week.',
      'Decisions:',
      '- public_launch_date | Keep the public launch date tentative until signoff lands.',
      'Open Questions:',
      '- Will Nimbus Ledger sign off before Friday? | chief_of_staff',
      'Actions:',
      '- chief_of_staff | Get an explicit yes or no from Nimbus Ledger before the next update.',
      'Contradictions:',
      '- readiness_conflict | Team language says launch-ready while signoff is still open.',
    ].join('\n'),
    [
      'Why It Matters: Aurora Anchor still blocks the billing migration cutover.',
      'Current State: The team is sequencing launch communications around the vendor gate.',
      'Facts:',
      '- launch_comms | Launch communications remain tentative until signoff is explicit.',
      'Changes:',
      '- dependency_update | Nimbus Ledger requested one more approval pass before cutover.',
      'Decisions:',
      '- staffing_focus | Keep the team focused on cutover-critical work only.',
      'Actions:',
      '- ops | Update the handoff packet before the staffing review.',
      'Contradictions:',
      '- staffing_conflict | The accelerated date still conflicts with the staffing plan.',
    ].join('\n'),
  ]

  const first = await captureCanonicalMemory({
    tenantId,
    sourceSystem: 'notes',
    sourceRef: 'aurora-anchor/ops-note-1',
    scope: 'projects',
    title: 'Aurora Anchor operating note',
    body: bodies[0],
    bodyEncrypted: await encryptForTest(bodies[0], tmk),
    artifactRef: {
      filename: 'aurora-anchor-ops-note.txt',
      mediaType: 'text/plain',
      contentEncrypted: await encryptForTest('Aurora artifact payload', tmk),
    },
    capturedAt: 1_777_000_100_000,
  }, env, tenantId)

  const second = await captureCanonicalMemory({
    tenantId,
    sourceSystem: 'notes',
    sourceRef: 'aurora-anchor/ops-note-2',
    scope: 'projects',
    title: 'Aurora Anchor staffing note',
    body: bodies[1],
    bodyEncrypted: await encryptForTest(bodies[1], tmk),
    capturedAt: 1_777_000_200_000,
  }, env, tenantId)

  return [
    { captureId: first.captureId, documentId: first.documentId },
    { captureId: second.captureId, documentId: second.documentId },
  ]
}

async function persistAuroraDecisionLog(
  tenantId: string,
  sources: Array<{ captureId: string; documentId: string }>,
): Promise<void> {
  await persistCompiledSynthesis({
    tenantId,
    document: {
      stableKey: 'decision-log:aurora-anchor',
      family: 'decision_log',
      scope: 'projects',
      title: 'Aurora Anchor Decision Log',
      summary: 'Current decisions that should remain sticky for follow-on sessions.',
      audience: 'chief_of_staff',
    },
    sources: sources.map((source, index) => ({
      sourceRole: index === 0 ? 'primary' : 'supporting',
      canonicalCaptureId: source.captureId,
      canonicalDocumentId: source.documentId,
    })),
    changeView: {
      stableKey: 'decision-log:aurora-anchor',
      scope: 'projects',
      viewKind: 'decision_log',
      title: 'Aurora Anchor Decision Log',
      summary: 'Decision-oriented compiled view for Chief of Staff prep.',
      decisions: [
        {
          summary: 'Keep the public launch date tentative until vendor signoff lands.',
          decisionStableKey: 'decision:project:aurora-anchor:launch-date',
          status: 'active',
        },
      ],
      recommendedActions: [
        {
          summary: 'Carry the launch-date constraint into the next leadership update.',
          status: 'pending',
          owner: 'chief_of_staff',
        },
      ],
      sourceRefs: sources.map((source, index) => ({
        label: index === 0 ? 'Primary canonical note' : 'Supporting canonical note',
        sourceRole: index === 0 ? 'primary' : 'supporting',
        canonicalCaptureId: source.captureId,
        canonicalDocumentId: source.documentId,
      })),
    },
    artifacts: [
      {
        artifactRole: 'decision_log_json',
        format: 'json',
        version: 'v1',
        contentEncrypted: JSON.stringify({ stableKey: 'decision-log:aurora-anchor' }),
      },
    ],
  }, env)
}

async function encryptFixture(
  fixture: CanonicalPipelineCaptureInput,
  suffix: string,
  tmk: CryptoKey,
): Promise<CanonicalPipelineCaptureInput> {
  return {
    ...fixture,
    tenantId: FALLBACK_TENANT_ID,
    sourceRef: `${fixture.sourceRef}-${suffix}`,
    bodyEncrypted: await encryptContentForArchive(fixture.body, tmk),
  }
}

function createRuntimeEnv(state: { recallResults: HindsightRecallRow[]; capture: HindsightCaptureState; graph?: boolean }): typeof env {
  const { testEnv } = createGraphitiContainerTestEnv(
    state.graph === false ? { startFails: 'graphiti container unavailable' } : undefined,
  )
  const runtimeEnv = {
    ...createHindsightTestEnv({ capture: state.capture, operationStatus: 'completed', recallResults: state.recallResults }),
    GRAPHITI_RUNTIME_MODE: testEnv.GRAPHITI_RUNTIME_MODE,
    GRAPHITI: testEnv.GRAPHITI,
  } as typeof env
  installCanonicalMemoryTestStore(runtimeEnv)
  installCompiledSynthesisTestStore(runtimeEnv)
  return runtimeEnv
}

async function captureAndProject(args: {
  fixture: CanonicalPipelineCaptureInput
  suffix: string
  memoryType: 'episodic' | 'semantic' | 'world'
  testEnv: typeof env
  tmk: CryptoKey
}): Promise<SeededCapture> {
  const sendSpy = vi.spyOn(args.testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
  const input = await encryptFixture(args.fixture, args.suffix, args.tmk)
  const result = await captureThroughCanonicalPipeline({ ...input, memoryType: args.memoryType, compatibilityMode: 'current_hindsight' }, args.testEnv, FALLBACK_TENANT_ID)
  const pending: Promise<unknown>[] = []
  const message = sendSpy.mock.calls[0]?.[0] as { tenantId: string; payload: Record<string, unknown> }
  await processCanonicalProjectionDispatch(message.tenantId, message.payload, args.testEnv, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) } })
  await Promise.allSettled(pending)
  sendSpy.mockRestore()
  vi.restoreAllMocks()
  const projection = await installCanonicalMemoryTestStore(args.testEnv)
    .getLatestProjectionResultForOperation(FALLBACK_TENANT_ID, result.capture.operationId, 'hindsight')
  return {
    captureId: result.capture.captureId,
    documentId: result.capture.documentId,
    operationId: result.capture.operationId,
    engineDocumentId: projection!.engine_document_id,
  }
}

function buildStoredSource(documentId: string) {
  return {
    id: `compiled-source:${documentId}`,
    tenant_id: 'tenant',
    compiled_document_id: 'compiled-document',
    source_role: 'primary',
    canonical_capture_id: `capture:${documentId}`,
    canonical_document_id: documentId,
    canonical_artifact_id: null,
    canonical_operation_id: null,
    created_at: Date.now(),
  }
}

function buildSourceRef(documentId: string) {
  return {
    label: `Source ${documentId}`,
    sourceRole: 'primary',
    canonicalCaptureId: `capture:${documentId}`,
    canonicalDocumentId: documentId,
    canonicalArtifactId: null,
    canonicalOperationId: null,
  }
}

function buildContextPackReadModel(args: {
  compiledAt?: number | null
  sourceRefs?: Array<ReturnType<typeof buildSourceRef>>
  sources?: Array<ReturnType<typeof buildStoredSource>>
} = {}): CompiledContextPackReadModel {
  const compiledAt = args.compiledAt === undefined ? Date.now() : args.compiledAt
  return {
    document: {
      id: 'compiled-context-pack-document',
      tenant_id: 'tenant',
      stable_key: 'context-pack:project:aurora-anchor',
      family: 'context_pack',
      scope: 'projects',
      title: 'Aurora Anchor Context Pack',
      summary: 'Compiled context pack for testing.',
      audience: 'chief_of_staff',
      compiled_at: compiledAt as never,
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    sources: args.sources ?? [buildStoredSource('doc-context-pack')],
    artifacts: [],
    entities: [],
    facts: [],
    relationships: [],
    contradictions: [],
    dossier: null,
    contextPack: {
      record: {} as never,
      packKind: 'chief_of_staff_context_pack',
      title: 'Aurora Anchor Context Pack',
      summary: 'Compiled context pack for testing.',
      agentUsable: true,
      humanUsable: true,
      situation: 'Aurora Anchor is blocked on Nimbus Ledger signoff.',
      criticalFacts: [{ summary: 'Nimbus Ledger still owns the billing signoff.' } as never],
      recentChanges: [{ summary: 'Launch moved up by one week.', changedAt: Date.now() } as never],
      decisions: [{ summary: 'Keep the public launch date tentative.', status: 'active' } as never],
      contradictions: [],
      recommendedActions: [{ summary: 'Get an explicit signoff answer.', status: 'pending' } as never],
      sourceRefs: args.sourceRefs ?? [buildSourceRef('doc-context-pack')],
    },
    changeView: null,
  } as CompiledContextPackReadModel
}

function buildDossierReadModel(args: {
  sourceRefs?: Array<ReturnType<typeof buildSourceRef>>
  sources?: Array<ReturnType<typeof buildStoredSource>>
} = {}): CompiledDossierReadModel {
  return {
    document: {
      id: 'compiled-dossier-document',
      tenant_id: 'tenant',
      stable_key: 'dossier:project:aurora-anchor',
      family: 'dossier',
      scope: 'projects',
      title: 'Aurora Anchor Dossier',
      summary: 'Compiled dossier for testing.',
      audience: 'chief_of_staff',
      compiled_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    sources: args.sources ?? [buildStoredSource('doc-dossier')],
    artifacts: [],
    entities: [],
    facts: [],
    relationships: [],
    contradictions: [],
    dossier: {
      record: {} as never,
      dossierKind: 'project_dossier',
      subjectType: 'project',
      subjectStableKey: 'entity:project:aurora-anchor',
      subjectName: 'Aurora Anchor',
      whyItMatters: 'Aurora Anchor is the billing migration path.',
      currentState: 'Waiting on vendor signoff.',
      keyFacts: [{ summary: 'Billing cutover is blocked on Nimbus Ledger.' } as never],
      keyRelationships: [{ summary: 'Nimbus Ledger controls the vendor gate.' } as never],
      recentUpdates: [{ summary: 'Nimbus requested one more approval pass.', changedAt: Date.now() } as never],
      openQuestions: [{ question: 'Will Nimbus Ledger sign off before Friday?' } as never],
      contradictions: [],
      recommendedActions: [],
      recommendedNextReading: [],
      sourceRefs: args.sourceRefs ?? [buildSourceRef('doc-dossier')],
    },
    contextPack: null,
    changeView: null,
  } as CompiledDossierReadModel
}

function buildChangeViewReadModel(
  viewKind: 'decision_log' | 'what_changed',
  args: {
    sourceRefs?: Array<ReturnType<typeof buildSourceRef>>
    sources?: Array<ReturnType<typeof buildStoredSource>>
  } = {},
): CompiledChangeViewReadModel {
  return {
    document: {
      id: `compiled-${viewKind}-document`,
      tenant_id: 'tenant',
      stable_key: `${viewKind === 'decision_log' ? 'decision-log' : 'what-changed'}:aurora-anchor`,
      family: viewKind,
      scope: 'projects',
      title: viewKind === 'decision_log' ? 'Aurora Decision Log' : 'Aurora What Changed',
      summary: 'Compiled change view for testing.',
      audience: 'chief_of_staff',
      compiled_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    sources: args.sources ?? [buildStoredSource(`doc-${viewKind}`)],
    artifacts: [],
    entities: [],
    facts: [],
    relationships: [],
    contradictions: [],
    dossier: null,
    contextPack: null,
    changeView: {
      record: {} as never,
      viewKind,
      title: viewKind === 'decision_log' ? 'Aurora Decision Log' : 'Aurora What Changed',
      summary: 'Compiled change view for testing.',
      decisions: viewKind === 'decision_log' ? [{ summary: 'Keep the launch tentative.', status: 'active' } as never] : [],
      changes: viewKind === 'what_changed' ? [{ summary: 'Vendor requested one more approval pass.', changedAt: Date.now() } as never] : [],
      contradictions: [],
      recommendedActions: [{ summary: 'Carry the latest gate into the next update.', status: 'pending' } as never],
      sourceRefs: args.sourceRefs ?? [buildSourceRef(`doc-${viewKind}`)],
    },
  } as CompiledChangeViewReadModel
}

beforeAll(async () => {
  await ensureFallbackTenantWithKek()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('11.3 Chief of Staff compiled read path', () => {
  it('marks augment assets unused during runtime fallback and preserves source counts from stored links', async () => {
    vi.spyOn(compiledSynthesis, 'readCompiledContextPack').mockResolvedValue(
      buildContextPackReadModel({
        compiledAt: null,
        sourceRefs: [],
        sources: [buildStoredSource('doc-context-pack')],
      }),
    )
    vi.spyOn(compiledSynthesis, 'readCompiledDossier').mockResolvedValue(
      buildDossierReadModel({
        sourceRefs: [],
        sources: [buildStoredSource('doc-dossier')],
      }),
    )
    vi.spyOn(compiledSynthesis, 'readCompiledChangeView').mockImplementation(async (_tenantId, stableKey) =>
      stableKey.startsWith('decision-log')
        ? buildChangeViewReadModel('decision_log', {
          sourceRefs: [],
          sources: [buildStoredSource('doc-decision-log')],
        })
        : buildChangeViewReadModel('what_changed', {
          sourceRefs: [],
          sources: [buildStoredSource('doc-what-changed')],
        }))

    const result = await loadCompiledChiefOfStaffContext({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Aurora Anchor',
      scope: 'projects',
    }, env, 'tenant')

    expect(result?.bundle).toBeNull()
    expect(result?.metadata.mode).toBe('runtime_fallback')
    expect(result?.metadata.fallbackUsed).toBe(true)
    expect(result?.metadata.fallbackReason).toContain('missing a compiled timestamp')
    expect(result?.metadata.assets.every((asset) => asset.used === false)).toBe(true)
    expect(result?.metadata.assets.find((asset) => asset.asset === 'context_pack')?.sourceCount).toBe(1)
    expect(result?.metadata.assets.find((asset) => asset.asset === 'dossier')?.sourceCount).toBe(1)
    expect(result?.metadata.assets.find((asset) => asset.asset === 'what_changed')?.sourceCount).toBe(1)
    expect(result?.metadata.assets.find((asset) => asset.asset === 'decision_log')?.sourceCount).toBe(1)
  })

  it('keeps compiled-first context when an augment read fails and surfaces the read error as a gap', async () => {
    vi.spyOn(compiledSynthesis, 'readCompiledContextPack').mockResolvedValue(buildContextPackReadModel())
    vi.spyOn(compiledSynthesis, 'readCompiledDossier').mockRejectedValue(new Error('dossier read exploded'))
    vi.spyOn(compiledSynthesis, 'readCompiledChangeView').mockResolvedValue(null)

    const result = await loadCompiledChiefOfStaffContext({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Aurora Anchor',
      scope: 'projects',
    }, env, 'tenant')

    expect(result?.bundle).not.toBeNull()
    expect(result?.metadata.mode).toBe('compiled_first')
    expect(result?.metadata.fallbackUsed).toBe(false)
    expect(result?.metadata.assets.find((asset) => asset.asset === 'context_pack')?.used).toBe(true)
    expect(result?.metadata.assets.find((asset) => asset.asset === 'dossier')?.used).toBe(false)
    expect(result?.bundle?.gaps.some((gap) => gap.message.includes('Compiled dossier lookup encountered read errors'))).toBe(true)
    expect(result?.bundle?.evidence).toHaveLength(1)
  })

  it('prefers compiled context packs and augments with dossier plus recent-change/decision views while preserving metadata', async () => {
    const tenantId = `${TENANT_PREFIX}-compiled`
    const tmk = await createTmk()
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    const canonicalSources = await seedAuroraCanonicalTruth(tenantId, tmk)
    await compileProjectSynthesisFromCanonicalTruth({
      tenantId,
      subject: {
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
        keywords: ['Nimbus Ledger', 'billing migration'],
      },
      tmk,
    }, env)
    await persistAuroraDecisionLog(tenantId, canonicalSources)

    const bundle = await prepareContextForAgent({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Aurora Anchor',
      scope: 'projects',
      limit: 4,
    }, env, tenantId, { tmk })

    expect(bundle.compiled?.mode).toBe('compiled_first')
    expect(bundle.compiled?.fallbackUsed).toBe(false)
    expect(bundle.compiled?.freshnessPolicy).toContain('7 days')
    expect(bundle.compiled?.assets.find((asset) => asset.asset === 'context_pack')?.used).toBe(true)
    expect(bundle.compiled?.assets.find((asset) => asset.asset === 'dossier')?.used).toBe(true)
    expect(bundle.compiled?.assets.find((asset) => asset.asset === 'what_changed')?.used).toBe(true)
    expect(bundle.compiled?.assets.find((asset) => asset.asset === 'decision_log')?.used).toBe(true)
    expect(bundle.evidence.every((block) => block.mode === 'composed')).toBe(true)
    expect(bundle.highlights.some((item) => item.includes('Decision:'))).toBe(true)
    expect(bundle.relationships.some((item) => item.includes('Nimbus Ledger'))).toBe(true)
    expect(bundle.recentChanges.some((item) => item.includes('approval pass'))).toBe(true)
    expect(bundle.followUpQuestions.some((item) => item.includes('Will Nimbus Ledger sign off'))).toBe(true)
    expect(bundle.sources.map((source) => source.documentId).filter(Boolean).sort()).toEqual(
      canonicalSources.map((source) => source.documentId).sort(),
    )
    expect(bundle.confidence.level).toBe('high')
  })

  it('falls back to the older runtime path when compiled outputs are missing', async () => {
    const tmk = await deriveFallbackTmk()
    const recallResults: HindsightRecallRow[] = []
    const testEnv = createRuntimeEnv({ recallResults, capture: { retainCount: 0, operationIds: [] } })
    await captureAndProject({ fixture: projectNote, suffix: 'project-note', memoryType: 'episodic', testEnv, tmk })
    await captureAndProject({ fixture: projectGraphNote, suffix: 'project-graph', memoryType: 'episodic', testEnv, tmk })
    const seeded = await captureAndProject({ fixture: projectConversation, suffix: 'project-conversation', memoryType: 'semantic', testEnv, tmk })
    recallResults.splice(0, recallResults.length, {
      document_id: seeded.engineDocumentId,
      text: 'Launch plan is down to three milestones, optional work left the critical path, and the checklist owner is still unresolved.',
      score: 0.95,
      metadata: { source: 'mcp_memory_write', domain: 'general' },
    })

    const bundle = await prepareContextForAgent({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Launch plan',
      limit: 4,
    }, testEnv, FALLBACK_TENANT_ID, { tmk })

    expect(bundle.compiled?.mode).toBe('runtime_fallback')
    expect(bundle.compiled?.fallbackUsed).toBe(true)
    expect(bundle.compiled?.fallbackReason).toContain('No compiled context pack')
    expect(bundle.recentChanges.some((item) => item.includes('three milestones'))).toBe(true)
    expect(bundle.evidence.some((block) => block.mode === 'graph' && block.items.length > 0)).toBe(true)
    expect(bundle.sources.some((source) => source.mode === 'semantic')).toBe(true)
  })

  it('falls back when the primary compiled context pack is stale', async () => {
    const tenantId = `${TENANT_PREFIX}-stale-pack`
    const tmk = await createTmk()
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    await seedAuroraCanonicalTruth(tenantId, tmk)
    await compileProjectSynthesisFromCanonicalTruth({
      tenantId,
      subject: {
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
        keywords: ['Nimbus Ledger', 'billing migration'],
      },
      tmk,
    }, env)

    const staleAt = Date.now() - (8 * 24 * 60 * 60 * 1000)
    await getCompiledSynthesisStore(env).upsertCompiledDocument({
      tenantId,
      stableKey: 'context-pack:project:aurora-anchor',
      family: 'context_pack',
      scope: 'projects',
      title: 'Aurora Anchor Project Context Pack',
      summary: 'Stale compiled context pack for fallback verification.',
      audience: 'chief_of_staff',
      compiledAt: staleAt,
      updatedAt: staleAt,
    })

    const bundle = await prepareContextForAgent({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Aurora Anchor',
      scope: 'projects',
    }, env, tenantId, { tmk })

    expect(bundle.compiled?.mode).toBe('runtime_fallback')
    expect(bundle.compiled?.fallbackUsed).toBe(true)
    expect(bundle.compiled?.fallbackReason).toContain('older than the 7 day freshness window')
    expect(bundle.evidence.some((block) => block.mode === 'semantic')).toBe(true)
  })

  it('skips stale compiled augments while keeping the primary compiled-first path active and debuggable', async () => {
    const tenantId = `${TENANT_PREFIX}-stale-augment`
    const tmk = await createTmk()
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    const canonicalSources = await seedAuroraCanonicalTruth(tenantId, tmk)
    await compileProjectSynthesisFromCanonicalTruth({
      tenantId,
      subject: {
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
        keywords: ['Nimbus Ledger', 'billing migration'],
      },
      tmk,
    }, env)
    await persistAuroraDecisionLog(tenantId, canonicalSources)

    const staleAt = Date.now() - (8 * 24 * 60 * 60 * 1000)
    await getCompiledSynthesisStore(env).upsertCompiledDocument({
      tenantId,
      stableKey: 'decision-log:aurora-anchor',
      family: 'decision_log',
      scope: 'projects',
      title: 'Aurora Anchor Decision Log',
      summary: 'Stale decision log for augment-skip verification.',
      audience: 'chief_of_staff',
      compiledAt: staleAt,
      updatedAt: staleAt,
    })

    const bundle = await prepareContextForAgent({
      agent: 'chief_of_staff',
      intent: 'project',
      target: 'Aurora Anchor',
      scope: 'projects',
    }, env, tenantId, { tmk })

    expect(bundle.compiled?.mode).toBe('compiled_first')
    expect(bundle.compiled?.fallbackUsed).toBe(false)
    expect(bundle.compiled?.assets.find((asset) => asset.asset === 'decision_log')?.used).toBe(false)
    expect(bundle.gaps.some((gap) => gap.message.includes('Compiled decision view for Aurora Anchor was skipped'))).toBe(true)
  })
})
