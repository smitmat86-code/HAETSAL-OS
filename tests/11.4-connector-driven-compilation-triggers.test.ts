import { describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import {
  buildCanonicalCompiledChangeEvent,
  dispatchTargetedCompiledRefresh,
  planTargetedCompiledRefresh,
  readCompiledChangeView,
  readCompiledContextPack,
  readCompiledDossier,
  readCompiledSynthesis,
} from '../src/services/compiled-synthesis'
import { installCompiledSynthesisTestStore } from '../src/services/compiled-synthesis-postgres'
import { getOrCreateTenant } from '../src/services/tenant'

const SUITE_ID = crypto.randomUUID()
const TENANT_PREFIX = `test-tenant-compiled-114-${SUITE_ID}`

installCanonicalMemoryTestStore(env)
installCompiledSynthesisTestStore(env)

async function createTmk(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
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

function auroraBody(lines: string[]): string {
  return lines.join('\n')
}

describe('11.4 connector-driven compilation triggers', () => {
  it('creates a compact canonical change event and explicit targeted refresh plan for project truth changes', () => {
    const event = buildCanonicalCompiledChangeEvent({
      tenantId: 'tenant-114',
      changeType: 'capture_created',
      scope: 'projects',
      sourceSystem: 'notes',
      sourceRef: 'aurora-anchor/ops-note-1',
      title: 'Aurora Anchor operating note',
      body: auroraBody([
        'Why It Matters: Aurora Anchor governs the billing migration.',
        'Current State: Aurora Anchor is waiting on vendor signoff.',
      ]),
      captureId: 'capture-1',
      documentId: 'document-1',
      artifactId: 'artifact-1',
      operationId: 'operation-1',
    })

    expect(event.changedRecords).toEqual({
      captureId: 'capture-1',
      documentId: 'document-1',
      artifactId: 'artifact-1',
      operationId: 'operation-1',
    })
    expect(event.subjectHints).toEqual([
      expect.objectContaining({
        subjectKind: 'project',
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
        evidence: 'source_ref',
      }),
    ])

    const plan = planTargetedCompiledRefresh(event)
    expect(plan.targets.map((target) => target.stableKey)).toEqual([
      'dossier:project:aurora-anchor',
      'context-pack:project:aurora-anchor',
      'what-changed:project:aurora-anchor',
    ])
    expect(plan.targets.map((target) => target.family)).toEqual([
      'dossier',
      'context_pack',
      'what_changed',
    ])
    expect(plan.dispatchJobs).toEqual([
      expect.objectContaining({
        jobKind: 'project_compilation',
        targetStableKeys: [
          'dossier:project:aurora-anchor',
          'context-pack:project:aurora-anchor',
          'what-changed:project:aurora-anchor',
        ],
        subject: expect.objectContaining({
          stableKey: 'entity:project:aurora-anchor',
          name: 'Aurora Anchor',
          scope: 'projects',
        }),
      }),
    ])
  })

  it('dispatches targeted recompilation through the existing project compiler seam', async () => {
    const plan = planTargetedCompiledRefresh(buildCanonicalCompiledChangeEvent({
      tenantId: 'tenant-114-dispatch',
      changeType: 'capture_created',
      scope: 'projects',
      sourceSystem: 'notes',
      sourceRef: 'aurora-anchor/ops-note-1',
      title: 'Aurora Anchor operating note',
      body: auroraBody([
        'Why It Matters: Aurora Anchor governs the billing migration.',
      ]),
      captureId: 'capture-2',
      documentId: 'document-2',
      operationId: 'operation-2',
    }))
    const tmk = await createTmk()
    const compileProject = vi.fn().mockResolvedValue({
      sourceFingerprint: 'fp-114',
      sourceCount: 2,
      dossier: { stableKey: 'dossier:project:aurora-anchor', result: {} },
      contextPack: { stableKey: 'context-pack:project:aurora-anchor', result: {} },
      whatChanged: { stableKey: 'what-changed:project:aurora-anchor', result: {} },
    })

    const result = await dispatchTargetedCompiledRefresh(plan, env, { tmk, compileProject })

    expect(compileProject).toHaveBeenCalledTimes(1)
    expect(compileProject).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-114-dispatch',
      subject: expect.objectContaining({
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
      }),
      tmk,
    }), env)
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.dispatched).toEqual([
      {
        jobKind: 'project_compilation',
        subjectStableKey: 'entity:project:aurora-anchor',
        targetStableKeys: [
          'dossier:project:aurora-anchor',
          'context-pack:project:aurora-anchor',
          'what-changed:project:aurora-anchor',
        ],
        sourceFingerprint: 'fp-114',
        sourceCount: 2,
      },
    ])
  })

  it('triggers targeted project recompilation from a canonical write and preserves stable identities across repeated changes', async () => {
    const tenantId = `${TENANT_PREFIX}-triggered`
    const tmk = await createTmk()
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    const waitUntilTasks: Promise<unknown>[] = []
    const queueSend = vi.spyOn(env.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)

    const firstBody = auroraBody([
      'Why It Matters: Aurora Anchor governs the billing migration and weekly launch decisions.',
      'Current State: Billing cutover is active, but vendor signoff still gates launch.',
      'Facts:',
      '- status | Project status is yellow until Nimbus Ledger signs off.',
      'Relationships:',
      '- depends_on | Nimbus Ledger | Nimbus Ledger controls the billing signoff gate.',
      'Changes:',
      '- schedule_change | Leadership moved the target launch up by one week.',
      'Actions:',
      '- chief_of_staff | Get an explicit yes or no from Nimbus Ledger before the next update.',
    ])

    await captureThroughCanonicalPipeline({
      tenantId,
      sourceSystem: 'notes',
      sourceRef: 'aurora-anchor/ops-note-1',
      scope: 'projects',
      title: 'Aurora Anchor operating note',
      body: firstBody,
      bodyEncrypted: await encryptForTest(firstBody, tmk),
      compatibilityMode: 'off',
      capturedAt: 1_777_000_100_000,
    }, env, tenantId, {
      waitUntil: (promise) => {
        waitUntilTasks.push(promise)
      },
    }, tmk)

    await Promise.allSettled(waitUntilTasks.splice(0))

    const firstDossier = await readCompiledDossier(tenantId, 'dossier:project:aurora-anchor', env)
    const firstContextPack = await readCompiledContextPack(tenantId, 'context-pack:project:aurora-anchor', env)
    const firstWhatChanged = await readCompiledChangeView(tenantId, 'what-changed:project:aurora-anchor', env)

    expect(firstDossier?.document.id).toBeTruthy()
    expect(firstContextPack?.document.id).toBeTruthy()
    expect(firstWhatChanged?.document.id).toBeTruthy()
    expect(firstDossier?.dossier.subjectStableKey).toBe('entity:project:aurora-anchor')
    expect(firstContextPack?.contextPack.packKind).toBe('project_context_pack')
    expect(firstWhatChanged?.changeView.viewKind).toBe('what_changed')

    const secondBody = auroraBody([
      'Why It Matters: Aurora Anchor still sets the billing migration tempo.',
      'Current State: Vendor signoff is closer, but the launch packet still needs one more revision.',
      'Changes:',
      '- launch_packet_update | The handoff packet was revised for the next staffing review.',
      'Actions:',
      '- chief_of_staff | Carry the revised launch packet into the Friday review.',
    ])

    await captureThroughCanonicalPipeline({
      tenantId,
      sourceSystem: 'notes',
      sourceRef: 'aurora-anchor/ops-note-2',
      scope: 'projects',
      title: 'Aurora Anchor launch packet note',
      body: secondBody,
      bodyEncrypted: await encryptForTest(secondBody, tmk),
      compatibilityMode: 'off',
      capturedAt: 1_777_000_200_000,
    }, env, tenantId, {
      waitUntil: (promise) => {
        waitUntilTasks.push(promise)
      },
    }, tmk)

    await Promise.allSettled(waitUntilTasks.splice(0))
    queueSend.mockRestore()

    const secondDossier = await readCompiledDossier(tenantId, 'dossier:project:aurora-anchor', env)
    const secondContextPack = await readCompiledContextPack(tenantId, 'context-pack:project:aurora-anchor', env)
    const secondWhatChanged = await readCompiledChangeView(tenantId, 'what-changed:project:aurora-anchor', env)
    const rawDossier = await readCompiledSynthesis(tenantId, 'dossier:project:aurora-anchor', env)

    expect(secondDossier?.document.id).toBe(firstDossier?.document.id)
    expect(secondContextPack?.document.id).toBe(firstContextPack?.document.id)
    expect(secondWhatChanged?.document.id).toBe(firstWhatChanged?.document.id)
    expect(secondWhatChanged?.changeView.sourceRefs).toHaveLength(2)
    expect(rawDossier?.artifacts.filter((artifact) => artifact.artifact_role === 'dossier_markdown')).toHaveLength(2)
  })

  it('keeps the existing canonical pipeline functional when no TMK is available for targeted compilation', async () => {
    const tenantId = `${TENANT_PREFIX}-no-tmk`
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    const queueSend = vi.spyOn(env.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)

    const result = await captureThroughCanonicalPipeline({
      tenantId,
      sourceSystem: 'notes',
      sourceRef: 'aurora-anchor/ops-note-3',
      scope: 'projects',
      title: 'Aurora Anchor no-TMK note',
      body: auroraBody([
        'Why It Matters: Aurora Anchor still matters.',
      ]),
      bodyEncrypted: 'already-encrypted-for-existing-path',
      compatibilityMode: 'off',
      capturedAt: 1_777_000_300_000,
    }, env, tenantId)

    queueSend.mockRestore()

    expect(result.capture.captureId).toBeTruthy()
    expect(result.capture.documentId).toBeTruthy()
    expect(result.dispatch.status).toBe('queued')
    expect(await readCompiledDossier(tenantId, 'dossier:project:aurora-anchor', env)).toBeNull()
  })
})
