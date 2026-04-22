import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  persistCompiledSynthesis,
  readCompiledSynthesis,
} from '../src/services/compiled-synthesis'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-compiled-110-${SUITE_ID}`

describe('11.0 haetsal compiled synthesis foundation', () => {
  it('stores compiled record families with canonical provenance and generated artifact refs', async () => {
    const result = await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'context-pack:chief-of-staff:weekly-ops',
        family: 'context_pack',
        scope: 'operations',
        title: 'Weekly Ops Context Pack',
        summary: 'Compiled decision-ready ops view for the Chief of Staff.',
        audience: 'hybrid',
      },
      sources: [
        {
          sourceRole: 'primary',
          canonicalCaptureId: 'capture-1',
          canonicalDocumentId: 'document-1',
          canonicalOperationId: 'operation-1',
        },
        {
          sourceRole: 'supporting',
          canonicalCaptureId: 'capture-2',
          canonicalArtifactId: 'artifact-2',
        },
      ],
      entities: [
        {
          stableKey: 'entity:project:northgate-studio',
          scope: 'operations',
          entityType: 'project',
          name: 'Northgate Studio',
          summary: 'Current operating focus for the weekly review.',
        },
        {
          stableKey: 'entity:partner:meridian-stack',
          scope: 'operations',
          entityType: 'partner',
          name: 'Meridian Stack',
          summary: 'External dependency surfaced in compiled ops notes.',
        },
      ],
      facts: [
        {
          stableKey: 'fact:project:northgate-studio:delivery-risk',
          scope: 'operations',
          subjectEntityStableKey: 'entity:project:northgate-studio',
          factType: 'delivery_risk',
          value: { level: 'medium', cause: 'dependency coordination' },
          summary: 'Delivery risk stays tied to unresolved dependency coordination.',
        },
      ],
      relationships: [
        {
          stableKey: 'relationship:northgate-studio:depends-on:meridian-stack',
          scope: 'operations',
          subjectEntityStableKey: 'entity:project:northgate-studio',
          objectEntityStableKey: 'entity:partner:meridian-stack',
          relationshipType: 'depends_on',
          summary: 'Northgate Studio depends on Meridian Stack for delivery planning.',
        },
      ],
      contradictions: [
        {
          stableKey: 'contradiction:northgate-studio:delivery-plan-vs-risk',
          scope: 'operations',
          leftFactStableKey: 'fact:project:northgate-studio:delivery-risk',
          title: 'Delivery plan confidence mismatch',
          summary: 'The plan says on-track while the dependency fact still marks medium delivery risk.',
          status: 'open',
        },
      ],
      contextPack: {
        stableKey: 'context-pack:chief-of-staff:weekly-ops',
        scope: 'operations',
        packKind: 'chief_of_staff_brief',
        title: 'Weekly Ops Context Pack',
        summary: 'Agent-usable and human-readable pack for the next ops review.',
        agentUsable: true,
        humanUsable: true,
      },
      artifacts: [
        {
          artifactRole: 'dossier',
          format: 'markdown',
          version: 'v1',
          contentEncrypted: '# Weekly Ops Context Pack\n\nEncrypted placeholder payload for the markdown dossier.',
        },
        {
          artifactRole: 'context_object',
          format: 'json',
          version: 'v1',
          contentEncrypted: JSON.stringify({
            title: 'Weekly Ops Context Pack',
            openLoops: ['Resolve Meridian Stack dependency'],
          }),
        },
      ],
    }, env)

    const bundle = await readCompiledSynthesis(TENANT_ID, 'context-pack:chief-of-staff:weekly-ops', env)

    expect(result.documentId).toBeTruthy()
    expect(result.entityIds).toHaveLength(2)
    expect(result.factIds).toHaveLength(1)
    expect(result.relationshipIds).toHaveLength(1)
    expect(result.contradictionIds).toHaveLength(1)
    expect(result.contextPackId).toBeTruthy()
    expect(result.artifactRefs).toHaveLength(2)

    expect(bundle?.document.family).toBe('context_pack')
    expect(bundle?.document.audience).toBe('hybrid')
    expect(bundle?.sources).toHaveLength(2)
    expect(bundle?.sources[0]?.canonical_capture_id).toBe('capture-1')
    expect(bundle?.sources[0]?.canonical_document_id).toBe('document-1')
    expect(bundle?.artifacts.map((row) => row.artifact_role).sort()).toEqual(['context_object', 'dossier'])
    expect(bundle?.entities.map((row) => row.entity_type)).toEqual(['partner', 'project'])
    expect(bundle?.facts[0]?.subject_entity_id).toBeTruthy()
    expect(bundle?.relationships[0]?.subject_entity_id).toBeTruthy()
    expect(bundle?.relationships[0]?.object_entity_id).toBeTruthy()
    expect(bundle?.contradictions[0]?.left_fact_id).toBe(bundle?.facts[0]?.id)
    expect(bundle?.contextPack?.agent_usable).toBe(true)
    expect(bundle?.contextPack?.human_usable).toBe(true)

    const markdownArtifact = bundle?.artifacts.find((row) => row.artifact_role === 'dossier')
    const jsonArtifact = bundle?.artifacts.find((row) => row.artifact_role === 'context_object')
    const storedMarkdown = await env.R2_ARTIFACTS.get(markdownArtifact!.r2_key)
    const storedJson = await env.R2_ARTIFACTS.get(jsonArtifact!.r2_key)

    expect(markdownArtifact?.r2_key).toContain(`compiled/${TENANT_ID.toLowerCase()}/context-pack/context-pack-chief-of-staff-weekly-ops/dossier/v1.md`)
    expect(jsonArtifact?.r2_key).toContain(`compiled/${TENANT_ID.toLowerCase()}/context-pack/context-pack-chief-of-staff-weekly-ops/context-object/v1.json`)
    expect(await storedMarkdown?.text()).toContain('Weekly Ops Context Pack')
    expect(await storedJson?.text()).toContain('openLoops')
  })

  it('preserves stable compiled identities across regeneration while versioning artifacts safely', async () => {
    const first = await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'entity-dossier:project:northgate-studio',
        family: 'entity',
        scope: 'operations',
        title: 'Northgate Studio Dossier',
        summary: 'Initial compiled dossier.',
        audience: 'hybrid',
      },
      sources: [
        { sourceRole: 'primary', canonicalCaptureId: 'capture-regen-1', canonicalDocumentId: 'document-regen-1' },
      ],
      entities: [
        {
          stableKey: 'entity:project:northgate-studio',
          scope: 'operations',
          entityType: 'project',
          name: 'Northgate Studio',
          summary: 'Initial entity summary.',
        },
      ],
      facts: [
        {
          stableKey: 'fact:project:northgate-studio:focus',
          scope: 'operations',
          subjectEntityStableKey: 'entity:project:northgate-studio',
          factType: 'focus',
          value: { theme: 'delivery readiness' },
          summary: 'Initial compiled focus.',
        },
      ],
      contextPack: {
        stableKey: 'context-pack:project:northgate-studio',
        scope: 'operations',
        packKind: 'project_brief',
        title: 'Northgate Studio Pack',
        summary: 'Initial pack revision.',
        agentUsable: true,
        humanUsable: false,
      },
      artifacts: [
        {
          artifactRole: 'dossier',
          format: 'markdown',
          version: 'v1',
          contentEncrypted: '# Northgate Studio\n\nInitial dossier payload.',
        },
      ],
    }, env)

    const second = await persistCompiledSynthesis({
      tenantId: TENANT_ID,
      document: {
        stableKey: 'entity-dossier:project:northgate-studio',
        family: 'entity',
        scope: 'operations',
        title: 'Northgate Studio Dossier',
        summary: 'Regenerated compiled dossier with fresher synthesis.',
        audience: 'hybrid',
      },
      sources: [
        { sourceRole: 'primary', canonicalCaptureId: 'capture-regen-2', canonicalDocumentId: 'document-regen-2' },
      ],
      entities: [
        {
          stableKey: 'entity:project:northgate-studio',
          scope: 'operations',
          entityType: 'project',
          name: 'Northgate Studio',
          summary: 'Regenerated entity summary.',
        },
      ],
      facts: [
        {
          stableKey: 'fact:project:northgate-studio:focus',
          scope: 'operations',
          subjectEntityStableKey: 'entity:project:northgate-studio',
          factType: 'focus',
          value: { theme: 'execution coordination' },
          summary: 'Refreshed compiled focus.',
        },
      ],
      contextPack: {
        stableKey: 'context-pack:project:northgate-studio',
        scope: 'operations',
        packKind: 'project_brief',
        title: 'Northgate Studio Pack',
        summary: 'Regenerated pack revision.',
        agentUsable: true,
        humanUsable: true,
      },
      artifacts: [
        {
          artifactRole: 'dossier',
          format: 'markdown',
          version: 'v2',
          contentEncrypted: '# Northgate Studio\n\nRegenerated dossier payload.',
        },
      ],
    }, env)

    const bundle = await readCompiledSynthesis(TENANT_ID, 'entity-dossier:project:northgate-studio', env)

    expect(second.documentId).toBe(first.documentId)
    expect(second.entityIds[0]).toBe(first.entityIds[0])
    expect(second.factIds[0]).toBe(first.factIds[0])
    expect(second.contextPackId).toBe(first.contextPackId)
    expect(bundle?.document.summary).toContain('Regenerated')
    expect(bundle?.sources).toHaveLength(1)
    expect(bundle?.sources[0]?.canonical_capture_id).toBe('capture-regen-2')
    expect(bundle?.facts[0]?.value_json).toContain('execution coordination')
    expect(bundle?.contextPack?.human_usable).toBe(true)
    expect(bundle?.artifacts.map((row) => row.version)).toEqual(['v1', 'v2'])

    const v1 = bundle?.artifacts.find((row) => row.version === 'v1')
    const v2 = bundle?.artifacts.find((row) => row.version === 'v2')
    expect(await (await env.R2_ARTIFACTS.get(v1!.r2_key))?.text()).toContain('Initial dossier payload')
    expect(await (await env.R2_ARTIFACTS.get(v2!.r2_key))?.text()).toContain('Regenerated dossier payload')
  })
})
