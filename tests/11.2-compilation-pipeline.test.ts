import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { captureCanonicalMemory } from '../src/services/canonical-memory'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { installCompiledSynthesisTestStore } from '../src/services/compiled-synthesis-postgres'
import { getOrCreateTenant } from '../src/services/tenant'
import {
  compileProjectSynthesisFromCanonicalTruth,
  readCompiledChangeView,
  readCompiledContextPack,
  readCompiledDossier,
  readCompiledSynthesis,
} from '../src/services/compiled-synthesis'

const SUITE_ID = crypto.randomUUID()
const TENANT_PREFIX = `test-tenant-compiled-112-${SUITE_ID}`

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

async function seedAuroraCanonicalTruth(
  tenantId: string,
  tmk: CryptoKey,
  capturedAtOffset = 0,
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
    capturedAt: 1_777_000_100_000 + capturedAtOffset,
  }, env, tenantId)

  const second = await captureCanonicalMemory({
    tenantId,
    sourceSystem: 'notes',
    sourceRef: 'aurora-anchor/ops-note-2',
    scope: 'projects',
    title: 'Aurora Anchor staffing note',
    body: bodies[1],
    bodyEncrypted: await encryptForTest(bodies[1], tmk),
    capturedAt: 1_777_000_200_000 + capturedAtOffset,
  }, env, tenantId)

  return [
    { captureId: first.captureId, documentId: first.documentId },
    { captureId: second.captureId, documentId: second.documentId },
  ]
}

describe('11.2 compilation pipeline', () => {
  it('compiles a project dossier, project context pack, and what-changed view from canonical truth end-to-end', async () => {
    const tenantId = `${TENANT_PREFIX}-e2e`
    const tmk = await createTmk()
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    const canonicalSources = await seedAuroraCanonicalTruth(tenantId, tmk)

    const result = await compileProjectSynthesisFromCanonicalTruth({
      tenantId,
      subject: {
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
        keywords: ['Nimbus Ledger', 'billing migration'],
      },
      tmk,
    }, env)

    const dossier = await readCompiledDossier(tenantId, result.dossier.stableKey, env)
    const contextPack = await readCompiledContextPack(tenantId, result.contextPack.stableKey, env)
    const whatChanged = await readCompiledChangeView(tenantId, result.whatChanged.stableKey, env)
    const dossierRaw = await readCompiledSynthesis(tenantId, result.dossier.stableKey, env)
    const contextRaw = await readCompiledSynthesis(tenantId, result.contextPack.stableKey, env)
    const changeRaw = await readCompiledSynthesis(tenantId, result.whatChanged.stableKey, env)

    expect(result.sourceCount).toBe(2)
    expect(dossier?.document.family).toBe('dossier')
    expect(dossier?.dossier.dossierKind).toBe('project_dossier')
    expect(dossier?.dossier.subjectStableKey).toBe('entity:project:aurora-anchor')
    expect(dossier?.entities.map((row) => row.name)).toContain('Aurora Anchor')
    expect(dossier?.facts.map((row) => row.fact_type)).toContain('status')
    expect(dossier?.relationships[0]?.relationship_type).toBe('depends-on')
    expect(dossier?.contradictions[0]?.stableKey).toContain('contradiction:project:aurora-anchor')
    expect(dossier?.sources.map((row) => row.canonical_capture_id).sort()).toEqual(
      canonicalSources.map((row) => row.captureId).sort(),
    )
    expect(dossier?.sources.map((row) => row.canonical_document_id).sort()).toEqual(
      canonicalSources.map((row) => row.documentId).sort(),
    )
    expect(dossier?.sources.some((row) => row.canonical_artifact_id)).toBe(true)
    expect(dossier?.dossier.sourceRefs.map((row) => row.canonicalDocumentId).sort()).toEqual(
      canonicalSources.map((row) => row.documentId).sort(),
    )

    expect(contextPack?.document.family).toBe('context_pack')
    expect(contextPack?.contextPack.packKind).toBe('project_context_pack')
    expect(contextPack?.contextPack.agentUsable).toBe(true)
    expect(contextPack?.contextPack.criticalFacts[0]?.factStableKey).toContain('fact:project:aurora-anchor')
    expect(contextPack?.contextPack.decisions[0]?.decisionStableKey).toContain('decision:project:aurora-anchor')
    expect(contextPack?.contextPack.sourceRefs.map((row) => row.canonicalCaptureId).sort()).toEqual(
      canonicalSources.map((row) => row.captureId).sort(),
    )

    expect(whatChanged?.document.family).toBe('what_changed')
    expect(whatChanged?.changeView.viewKind).toBe('what_changed')
    expect(whatChanged?.changeView.changes[0]?.changeKind).toBe('dependency-update')
    expect(whatChanged?.changeView.summary).toContain('additional recent change')
    expect(whatChanged?.changeView.sourceRefs.map((row) => row.canonicalDocumentId).sort()).toEqual(
      canonicalSources.map((row) => row.documentId).sort(),
    )

    expect(dossierRaw?.artifacts.map((row) => row.artifact_role).sort()).toEqual(['dossier_json', 'dossier_markdown'])
    expect(contextRaw?.artifacts.map((row) => row.artifact_role).sort()).toEqual(['context_pack_json', 'context_pack_markdown'])
    expect(changeRaw?.artifacts.map((row) => row.artifact_role).sort()).toEqual(['what_changed_json', 'what_changed_markdown'])

    const dossierMarkdown = dossierRaw?.artifacts.find((row) => row.artifact_role === 'dossier_markdown')
    const dossierJson = dossierRaw?.artifacts.find((row) => row.artifact_role === 'dossier_json')
    const contextJson = contextRaw?.artifacts.find((row) => row.artifact_role === 'context_pack_json')
    const changeMarkdown = changeRaw?.artifacts.find((row) => row.artifact_role === 'what_changed_markdown')

    expect(dossierMarkdown?.r2_key).toContain('/dossier/')
    expect(dossierJson?.r2_key).toContain('/dossier/')
    expect(contextJson?.r2_key).toContain('/context-pack/')
    expect(changeMarkdown?.r2_key).toContain('/what-changed/')

    expect(await (await env.R2_ARTIFACTS.get(dossierMarkdown!.r2_key))?.text()).toContain('Aurora Anchor Project Dossier')
    expect(await (await env.R2_ARTIFACTS.get(dossierJson!.r2_key))?.text()).toContain('"sourceFingerprint"')
    expect(await (await env.R2_ARTIFACTS.get(contextJson!.r2_key))?.text()).toContain('"criticalFacts"')
    expect(await (await env.R2_ARTIFACTS.get(changeMarkdown!.r2_key))?.text()).toContain('What Changed')
  })

  it('preserves stable compiled identity across repeated runs and versions artifacts safely when canonical truth changes', async () => {
    const tenantId = `${TENANT_PREFIX}-regen`
    const tmk = await createTmk()
    await getOrCreateTenant(tenantId, `${tenantId}-jwt`, env)
    await seedAuroraCanonicalTruth(tenantId, tmk, 5_000)

    const input = {
      tenantId,
      subject: {
        stableKey: 'entity:project:aurora-anchor',
        name: 'Aurora Anchor',
        scope: 'projects',
        keywords: ['Nimbus Ledger', 'billing migration'],
      },
      tmk,
    }

    const first = await compileProjectSynthesisFromCanonicalTruth(input, env)
    const second = await compileProjectSynthesisFromCanonicalTruth(input, env)

    expect(second.dossier.result.documentId).toBe(first.dossier.result.documentId)
    expect(second.contextPack.result.documentId).toBe(first.contextPack.result.documentId)
    expect(second.whatChanged.result.documentId).toBe(first.whatChanged.result.documentId)
    expect(second.dossier.result.artifactRefs.map((row) => row.r2Key)).toEqual(
      first.dossier.result.artifactRefs.map((row) => row.r2Key),
    )

    const updatedBody = [
      'Why It Matters: Aurora Anchor still sets the billing migration tempo.',
      'Current State: Vendor signoff is closer, but the launch packet still needs one more revision.',
      'Changes:',
      '- launch_packet_update | The handoff packet was revised for the next staffing review.',
      'Actions:',
      '- chief_of_staff | Carry the revised launch packet into the Friday review.',
    ].join('\n')

    await captureCanonicalMemory({
      tenantId,
      sourceSystem: 'notes',
      sourceRef: 'aurora-anchor/ops-note-3',
      scope: 'projects',
      title: 'Aurora Anchor launch packet note',
      body: updatedBody,
      bodyEncrypted: await encryptForTest(updatedBody, tmk),
      capturedAt: 1_777_000_300_000,
    }, env, tenantId)

    const third = await compileProjectSynthesisFromCanonicalTruth(input, env)
    const dossier = await readCompiledSynthesis(tenantId, third.dossier.stableKey, env)

    expect(third.dossier.result.documentId).toBe(first.dossier.result.documentId)
    expect(third.contextPack.result.documentId).toBe(first.contextPack.result.documentId)
    expect(third.whatChanged.result.documentId).toBe(first.whatChanged.result.documentId)
    expect(third.sourceFingerprint).not.toBe(first.sourceFingerprint)
    expect(dossier?.artifacts.filter((row) => row.artifact_role === 'dossier_markdown')).toHaveLength(2)
    expect(dossier?.artifacts.map((row) => row.version)).toContain(first.dossier.result.artifactRefs[0]?.version)
    expect(dossier?.artifacts.map((row) => row.version)).toContain(third.dossier.result.artifactRefs[0]?.version)
  })
})
