import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  persistCompiledSynthesis,
  readCompiledChangeView,
  readCompiledContextPack,
  readCompiledDossier,
  readCompiledSynthesis,
  readCompiledSynthesisView,
} from '../src/services/compiled-synthesis'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-compiled-111-${SUITE_ID}`

describe('11.1 dossier and context pack schema refinement', () => {
  it('stores dossier sections, contradiction objects, and markdown/json artifact linkage coherently', async () => {
    const result = await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'dossier:project:aurora-anchor',
        family: 'dossier',
        scope: 'projects',
        title: 'Aurora Anchor Project Dossier',
        summary: 'Compiled project dossier for the current operating picture.',
        audience: 'human_readable',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-dossier-1',
          canonicalDocumentId: 'document-dossier-1',
          canonicalOperationId: 'operation-dossier-1',
        },
      ],
      entities: [
        {
          stableKey: 'entity:project:aurora-anchor',
          scope: 'projects',
          entityType: 'project',
          name: 'Aurora Anchor',
          summary: 'Revenue-system migration project with cross-team dependency risk.',
        },
        {
          stableKey: 'entity:vendor:nimbus-ledger',
          scope: 'projects',
          entityType: 'vendor',
          name: 'Nimbus Ledger',
          summary: 'External billing integration partner.',
        },
      ],
      facts: [
        {
          stableKey: 'fact:project:aurora-anchor:status',
          scope: 'projects',
          subjectEntityStableKey: 'entity:project:aurora-anchor',
          factType: 'status',
          value: { status: 'yellow', reason: 'integration cutover not signed off' },
          summary: 'Project status is yellow because integration signoff is still open.',
        },
      ],
      relationships: [
        {
          stableKey: 'relationship:aurora-anchor:depends-on:nimbus-ledger',
          scope: 'projects',
          subjectEntityStableKey: 'entity:project:aurora-anchor',
          objectEntityStableKey: 'entity:vendor:nimbus-ledger',
          relationshipType: 'depends_on',
          summary: 'Aurora Anchor depends on Nimbus Ledger for billing cutover approval.',
        },
      ],
      contradictions: [
        {
          stableKey: 'contradiction:aurora-anchor:ready-vs-signoff',
          scope: 'projects',
          leftFactStableKey: 'fact:project:aurora-anchor:status',
          title: 'Readiness narrative conflict',
          contradictionKind: 'readiness_conflict',
          conflictScope: 'delivery_readiness',
          severity: 'high',
          freshness: 'fresh',
          summary: 'Leadership says the project is ready while the core status fact still shows missing billing signoff.',
          status: 'open',
          leftClaim: {
            summary: 'Compiled status marks the project yellow until Nimbus Ledger signs off.',
            factStableKey: 'fact:project:aurora-anchor:status',
            sourceRole: 'primary',
          },
          rightClaim: {
            summary: 'Meeting notes claim the cutover is ready to launch this week.',
            sourceRole: 'supporting',
          },
          suggestedResolution: 'Reconcile the launch claim against the explicit signoff gate before announcing readiness.',
        },
      ],
      dossier: {
        stableKey: 'dossier:project:aurora-anchor',
        scope: 'projects',
        dossierKind: 'project_dossier',
        subjectType: 'project',
        subjectStableKey: 'entity:project:aurora-anchor',
        subjectName: 'Aurora Anchor',
        whyItMatters: 'This project blocks the billing migration and affects weekly operating decisions.',
        currentState: 'Execution is active, but billing signoff remains the gating dependency.',
        keyFacts: [
          {
            label: 'Status',
            summary: 'Yellow until billing signoff lands.',
            factStableKey: 'fact:project:aurora-anchor:status',
            subjectStableKey: 'entity:project:aurora-anchor',
          },
        ],
        keyRelationships: [
          {
            label: 'Critical dependency',
            summary: 'Nimbus Ledger owns the billing approval gate.',
            relationshipStableKey: 'relationship:aurora-anchor:depends-on:nimbus-ledger',
            counterpartStableKey: 'entity:vendor:nimbus-ledger',
          },
        ],
        recentUpdates: [
          {
            summary: 'Ops review flagged unresolved signoff as the only launch blocker.',
            changeKind: 'status_update',
            changedAt: 1777000100000,
          },
        ],
        openQuestions: [
          {
            question: 'Will Nimbus Ledger sign off before the Friday cutover window?',
            status: 'open',
            owner: 'billing-team',
          },
        ],
        contradictions: [
          {
            contradictionStableKey: 'contradiction:aurora-anchor:ready-vs-signoff',
            summary: 'Launch-ready language conflicts with the still-open signoff fact.',
            status: 'open',
            severity: 'high',
          },
        ],
        recommendedActions: [
          {
            summary: 'Get an explicit yes/no from Nimbus Ledger before the next status update.',
            status: 'pending',
            owner: 'chief-of-staff',
          },
        ],
        recommendedNextReading: [
          {
            title: 'Aurora Anchor dossier markdown',
            note: 'Human-readable dossier render for briefing prep.',
            artifactRole: 'dossier_markdown',
          },
        ],
        sourceRefs: [
          {
            label: 'Primary source truth',
            sourceRole: 'primary',
            canonicalCaptureId: 'capture-dossier-1',
            canonicalDocumentId: 'document-dossier-1',
          },
        ],
      },
      artifacts: [
        {
          artifactRole: 'dossier_markdown',
          format: 'markdown',
          version: 'v1',
          contentEncrypted: '# Aurora Anchor\n\nProject dossier render.',
        },
        {
          artifactRole: 'dossier_json',
          format: 'json',
          version: 'v1',
          contentEncrypted: JSON.stringify({ stableKey: 'dossier:project:aurora-anchor', mode: 'machine' }),
        },
      ],
    }, env)

    const raw = await readCompiledSynthesis(TENANT_ID, 'dossier:project:aurora-anchor', env)
    const dossier = await readCompiledDossier(TENANT_ID, 'dossier:project:aurora-anchor', env)

    expect(result.dossierId).toBeTruthy()
    expect(raw?.dossier?.dossier_kind).toBe('project_dossier')
    expect(raw?.artifacts.map((artifact) => artifact.artifact_role).sort()).toEqual(['dossier_json', 'dossier_markdown'])
    expect(dossier?.dossier.subjectName).toBe('Aurora Anchor')
    expect(dossier?.dossier.whyItMatters).toContain('billing migration')
    expect(dossier?.dossier.keyFacts[0]?.factStableKey).toBe('fact:project:aurora-anchor:status')
    expect(dossier?.contradictions[0]?.severity).toBe('high')
    expect(dossier?.contradictions[0]?.leftClaim.factStableKey).toBe('fact:project:aurora-anchor:status')
    expect(dossier?.artifacts[0]?.r2_key).toContain(`compiled/${TENANT_ID.toLowerCase()}/dossier/dossier-project-aurora-anchor`)

    const markdown = raw?.artifacts.find((artifact) => artifact.artifact_role === 'dossier_markdown')
    const json = raw?.artifacts.find((artifact) => artifact.artifact_role === 'dossier_json')
    expect(await (await env.R2_ARTIFACTS.get(markdown!.r2_key))?.text()).toContain('Aurora Anchor')
    expect(await (await env.R2_ARTIFACTS.get(json!.r2_key))?.text()).toContain('"mode":"machine"')
  })

  it('stores explicit agent-usable context pack sections and reads them back through typed helpers', async () => {
    await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'context-pack:chief-of-staff:aurora-anchor',
        family: 'context_pack',
        scope: 'projects',
        title: 'Aurora Anchor Chief of Staff Pack',
        summary: 'Compact operational pack for the next Chief of Staff turn.',
        audience: 'chief_of_staff',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-pack-1',
          canonicalDocumentId: 'document-pack-1',
        },
      ],
      contradictions: [
        {
          stableKey: 'contradiction:aurora-anchor:scope-vs-capacity',
          scope: 'projects',
          contradictionKind: 'capacity_conflict',
          severity: 'medium',
          freshness: 'recent',
          summary: 'Scope commitments still exceed the staffing plan for this week.',
          status: 'noted',
          leftClaim: { summary: 'Current roadmap still contains all launch extras.' },
          rightClaim: { summary: 'Staffing plan assumes only billing cutover work this week.' },
        },
      ],
      contextPack: {
        stableKey: 'context-pack:chief-of-staff:aurora-anchor',
        scope: 'projects',
        packKind: 'chief_of_staff_context_pack',
        title: 'Aurora Anchor Chief of Staff Pack',
        summary: 'Agent-ready pack with the facts, changes, and pending actions.',
        agentUsable: true,
        humanUsable: true,
        situation: 'Aurora Anchor is approaching cutover, but billing signoff and staffing compression are still live concerns.',
        criticalFacts: [
          {
            label: 'Launch gate',
            summary: 'Billing signoff remains the hard launch gate.',
          },
        ],
        recentChanges: [
          {
            summary: 'Leadership moved the launch target up by one week.',
            changeKind: 'schedule_change',
            changedAt: 1777000200000,
          },
        ],
        decisions: [
          {
            summary: 'Keep the public launch date tentative until signoff lands.',
            decisionStableKey: 'decision:aurora-anchor:launch-date',
            status: 'active',
          },
        ],
        contradictions: [
          {
            contradictionStableKey: 'contradiction:aurora-anchor:scope-vs-capacity',
            summary: 'Scope commitments still exceed the staffing plan.',
            status: 'noted',
            severity: 'medium',
          },
        ],
        recommendedActions: [
          {
            summary: 'Prepare a fallback message in case signoff slips again.',
            status: 'suggested',
            owner: 'chief-of-staff',
          },
        ],
        sourceRefs: [
          {
            label: 'Current project packet',
            sourceRole: 'primary',
            canonicalCaptureId: 'capture-pack-1',
            canonicalDocumentId: 'document-pack-1',
          },
        ],
      },
      artifacts: [
        {
          artifactRole: 'context_pack_json',
          format: 'json',
          version: 'v1',
          contentEncrypted: JSON.stringify({ consumer: 'chief_of_staff', compact: true }),
        },
      ],
    }, env)

    const pack = await readCompiledContextPack(TENANT_ID, 'context-pack:chief-of-staff:aurora-anchor', env)
    const view = await readCompiledSynthesisView(TENANT_ID, 'context-pack:chief-of-staff:aurora-anchor', env)

    expect(pack?.contextPack.packKind).toBe('chief_of_staff_context_pack')
    expect(pack?.contextPack.agentUsable).toBe(true)
    expect(pack?.contextPack.humanUsable).toBe(true)
    expect(pack?.contextPack.situation).toContain('approaching cutover')
    expect(pack?.contextPack.decisions[0]?.decisionStableKey).toBe('decision:aurora-anchor:launch-date')
    expect(pack?.contextPack.contradictions[0]?.contradictionStableKey).toBe('contradiction:aurora-anchor:scope-vs-capacity')
    expect(view?.document.audience).toBe('chief_of_staff')
    expect(view?.artifacts[0]?.r2_key).toContain('/context-pack/')
  })

  it('stores decision log and what changed views as explicit compiled change-oriented read models', async () => {
    await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'decision-log:aurora-anchor',
        family: 'decision_log',
        scope: 'projects',
        title: 'Aurora Anchor Decision Log',
        summary: 'Current decisions that should remain sticky for follow-on sessions.',
        audience: 'agent_reusable',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-change-1',
          canonicalDocumentId: 'document-change-1',
        },
      ],
      changeView: {
        stableKey: 'decision-log:aurora-anchor',
        scope: 'projects',
        viewKind: 'decision_log',
        title: 'Aurora Anchor Decision Log',
        summary: 'Decision-oriented compiled view.',
        decisions: [
          {
            summary: 'Do not announce launch readiness until billing signoff is explicit.',
            decisionStableKey: 'decision:aurora-anchor:announce-readiness',
            status: 'active',
          },
        ],
        changes: [],
        contradictions: [],
        recommendedActions: [
          {
            summary: 'Carry this decision into the next leadership briefing.',
            status: 'pending',
          },
        ],
        sourceRefs: [
          {
            label: 'Decision thread',
            sourceRole: 'primary',
            canonicalCaptureId: 'capture-change-1',
          },
        ],
      },
      artifacts: [
        {
          artifactRole: 'decision_log_markdown',
          format: 'markdown',
          version: 'v1',
          contentEncrypted: '# Decision Log\n\nDo not announce readiness without signoff.',
        },
      ],
    }, env)

    await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'what-changed:aurora-anchor',
        family: 'what_changed',
        scope: 'projects',
        title: 'Aurora Anchor What Changed',
        summary: 'Recent deltas that matter to follow-on sessions.',
        audience: 'specialist_agent',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-change-2',
          canonicalDocumentId: 'document-change-2',
        },
      ],
      changeView: {
        stableKey: 'what-changed:aurora-anchor',
        scope: 'projects',
        viewKind: 'what_changed',
        title: 'Aurora Anchor What Changed',
        summary: 'Change-oriented compiled view.',
        decisions: [],
        changes: [
          {
            summary: 'Launch target moved up by one week.',
            changeKind: 'schedule_change',
            changedAt: 1777000300000,
          },
        ],
        contradictions: [
          {
            contradictionStableKey: 'contradiction:aurora-anchor:scope-vs-capacity',
            summary: 'Schedule acceleration makes the staffing mismatch more important.',
            status: 'noted',
            severity: 'medium',
          },
        ],
        recommendedActions: [
          {
            summary: 'Update the handoff packet before the next staffing review.',
            status: 'suggested',
          },
        ],
        sourceRefs: [
          {
            label: 'Change memo',
            sourceRole: 'primary',
            canonicalCaptureId: 'capture-change-2',
          },
        ],
      },
      artifacts: [
        {
          artifactRole: 'what_changed_json',
          format: 'json',
          version: 'v1',
          contentEncrypted: JSON.stringify({ deltaCount: 1 }),
        },
      ],
    }, env)

    const decisionLog = await readCompiledChangeView(TENANT_ID, 'decision-log:aurora-anchor', env)
    const whatChanged = await readCompiledChangeView(TENANT_ID, 'what-changed:aurora-anchor', env)

    expect(decisionLog?.changeView.viewKind).toBe('decision_log')
    expect(decisionLog?.document.family).toBe('decision_log')
    expect(decisionLog?.changeView.decisions[0]?.decisionStableKey).toBe('decision:aurora-anchor:announce-readiness')
    expect(whatChanged?.changeView.viewKind).toBe('what_changed')
    expect(whatChanged?.document.family).toBe('what_changed')
    expect(whatChanged?.changeView.changes[0]?.changeKind).toBe('schedule_change')
    expect(whatChanged?.artifacts[0]?.r2_key).toContain('/what-changed/')
  })

  it('preserves regeneration-safe identity across refined compiled families', async () => {
    const first = await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'dossier:person:mira-sol',
        family: 'dossier',
        scope: 'people',
        title: 'Mira Sol Dossier',
        summary: 'Initial person dossier.',
        audience: 'hybrid',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-regen-person-1',
          canonicalDocumentId: 'document-regen-person-1',
        },
      ],
      contradictions: [
        {
          stableKey: 'contradiction:mira-sol:availability',
          scope: 'people',
          summary: 'Availability expectations are not aligned yet.',
          status: 'open',
        },
      ],
      dossier: {
        stableKey: 'dossier:person:mira-sol',
        scope: 'people',
        dossierKind: 'person_dossier',
        subjectType: 'person',
        subjectStableKey: 'entity:person:mira-sol',
        subjectName: 'Mira Sol',
        currentState: 'Initial compiled state.',
      },
      artifacts: [
        {
          artifactRole: 'dossier_markdown',
          format: 'markdown',
          version: 'v1',
          contentEncrypted: '# Mira Sol\n\nInitial render.',
        },
      ],
    }, env)

    const second = await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'dossier:person:mira-sol',
        family: 'dossier',
        scope: 'people',
        title: 'Mira Sol Dossier',
        summary: 'Refined person dossier with fresher synthesis.',
        audience: 'hybrid',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-regen-person-2',
          canonicalDocumentId: 'document-regen-person-2',
        },
      ],
      contradictions: [
        {
          stableKey: 'contradiction:mira-sol:availability',
          scope: 'people',
          summary: 'Availability expectations remain unsettled after the reschedule.',
          status: 'open',
          freshness: 'fresh',
        },
      ],
      dossier: {
        stableKey: 'dossier:person:mira-sol',
        scope: 'people',
        dossierKind: 'person_dossier',
        subjectType: 'person',
        subjectStableKey: 'entity:person:mira-sol',
        subjectName: 'Mira Sol',
        currentState: 'Refined compiled state.',
        openQuestions: [
          {
            question: 'Will Mira confirm the revised review window today?',
            status: 'open',
          },
        ],
      },
      artifacts: [
        {
          artifactRole: 'dossier_markdown',
          format: 'markdown',
          version: 'v2',
          contentEncrypted: '# Mira Sol\n\nRefined render.',
        },
      ],
    }, env)

    const dossier = await readCompiledDossier(TENANT_ID, 'dossier:person:mira-sol', env)

    expect(second.documentId).toBe(first.documentId)
    expect(second.dossierId).toBe(first.dossierId)
    expect(second.contradictionIds[0]).toBe(first.contradictionIds[0])
    expect(dossier?.document.summary).toContain('Refined')
    expect(dossier?.sources[0]?.canonical_capture_id).toBe('capture-regen-person-2')
    expect(dossier?.dossier.currentState).toBe('Refined compiled state.')
    expect(dossier?.artifacts.map((artifact) => artifact.version)).toEqual(['v1', 'v2'])
  })
})
