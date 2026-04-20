import { beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import {
  buildCanonicalGraphProjectionPlan,
  buildCanonicalGraphProjectionStatus,
  GRAPHITI_DEPLOYMENT_POSTURE,
  reconcileGraphEdge,
  reconcileGraphEntity,
} from '../src/services/canonical-graph-projection-design'
import { getCanonicalMemoryStatus } from '../src/services/canonical-memory-status'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import artifactFixture from './fixtures/canonical-memory/artifact-capture.json'
import conversationFixture from './fixtures/canonical-memory/conversation-capture.json'
import noteFixture from './fixtures/canonical-memory/note-capture.json'
import edgeFixture from './fixtures/graphiti/edge-reconciliation.json'
import entityFixture from './fixtures/graphiti/entity-reconciliation.json'
import statusFixture from './fixtures/graphiti/graph-status.json'

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-graphiti-81-${SUITE_ID}`

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`graphiti-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('graphiti-salt'), info: new TextEncoder().encode('graphiti-info') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

async function encryptFixture(fixture: CanonicalPipelineCaptureInput, suffix: string): Promise<CanonicalPipelineCaptureInput> {
  const tmk = await deriveTestTmk()
  return { ...fixture, tenantId: TENANT_A, sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`, bodyEncrypted: await encryptContentForArchive(fixture.body, tmk) }
}

function toDesignInput(fixture: CanonicalPipelineCaptureInput, suffix: string) {
  return {
    tenantId: TENANT_A,
    captureId: `capture-${suffix}`,
    documentId: `document-${suffix}`,
    operationId: `operation-${suffix}`,
    scope: fixture.scope,
    sourceSystem: fixture.sourceSystem,
    sourceRef: `${fixture.sourceRef ?? 'fixture'}-${suffix}`,
    title: fixture.title ?? null,
    body: fixture.body,
    capturedAt: fixture.capturedAt ?? null,
    artifactRef: fixture.artifactRef ?? null,
  }
}

beforeAll(async () => {
  await ensureTenant(TENANT_A)
})

describe('8.1 graphiti projection design', () => {
  it('locks the initial Graphiti posture as HAETSAL-owned internal container runtime under the Cloudflare shell', () => {
    expect(GRAPHITI_DEPLOYMENT_POSTURE.id).toBe('haetsal_internal_container')
    expect(GRAPHITI_DEPLOYMENT_POSTURE.initialRuntime).toBe('internal_graphiti_container')
    expect(GRAPHITI_DEPLOYMENT_POSTURE.futureRuntime).toBe('cloudflare_containers')
  })

  it('classifies note, conversation, and artifact captures into deterministic graph candidates without embedding raw content', () => {
    const notePlan = buildCanonicalGraphProjectionPlan(toDesignInput(noteFixture as CanonicalPipelineCaptureInput, 'note'))
    const conversationPlan = buildCanonicalGraphProjectionPlan(toDesignInput(conversationFixture as CanonicalPipelineCaptureInput, 'conversation'))
    const artifactPlan = buildCanonicalGraphProjectionPlan(toDesignInput(artifactFixture as CanonicalPipelineCaptureInput, 'artifact'))

    expect(notePlan.episode.kind).toBe('note')
    expect(notePlan.entities.map(item => item.kind)).toEqual(expect.arrayContaining(['scope', 'source', 'topic']))
    expect(conversationPlan.episode.kind).toBe('conversation')
    expect(conversationPlan.entities.map(item => item.canonicalKey)).toEqual(expect.arrayContaining(['canonical://participants/user', 'canonical://participants/assistant']))
    expect(conversationPlan.edges.find(item => item.relation === 'conversed_with')?.temporalMode).toBe('append_valid_time')
    expect(artifactPlan.episode.kind).toBe('artifact')
    expect(artifactPlan.entities.map(item => item.kind)).toEqual(expect.arrayContaining(['document', 'artifact']))
    expect(artifactPlan.edges.find(item => item.relation === 'backed_by_artifact')).toBeTruthy()
    expect(JSON.stringify(conversationPlan)).not.toContain((conversationFixture as CanonicalPipelineCaptureInput).body)
  })

  it('reuses deterministic entities across captures and separates new entities when keys differ', () => {
    expect(reconcileGraphEntity(entityFixture.existing, entityFixture.incomingSame).action).toBe('reuse')
    expect(reconcileGraphEntity(entityFixture.existing, entityFixture.incomingNew).action).toBe('create')
  })

  it('deduplicates structural edges and appends temporal observations instead of replacing them', () => {
    expect(reconcileGraphEdge(edgeFixture.structuralExisting, edgeFixture.structuralIncoming).action).toBe('dedupe')
    expect(reconcileGraphEdge(edgeFixture.temporalExisting, edgeFixture.temporalIncoming).action).toBe('append_observation')
  })

  it('defines graph status examples and surfaces graph projection posture through canonical status', async () => {
    expect(buildCanonicalGraphProjectionStatus(statusFixture.accepted)?.status).toBe('pending')
    expect(buildCanonicalGraphProjectionStatus(statusFixture.queued)?.status).toBe('queued')
    expect(buildCanonicalGraphProjectionStatus(statusFixture.failed)?.status).toBe('failed')

    const testEnv = {
      ...env,
      QUEUE_BULK: { ...env.QUEUE_BULK, send: vi.fn().mockResolvedValue(undefined as never) },
    } as typeof env
    const input = await encryptFixture(noteFixture as CanonicalPipelineCaptureInput, 'status')
    const result = await captureThroughCanonicalPipeline({ ...input, compatibilityMode: 'off', memoryType: 'episodic' }, testEnv, TENANT_A)
    const status = await getCanonicalMemoryStatus({ tenantId: TENANT_A, operationId: result.capture.operationId }, testEnv, TENANT_A)

    expect(status.graph?.mode).toBe('graphiti')
    expect(status.graph?.status).toBe('queued')
    expect(status.graph?.ready).toBe(false)
    expect(JSON.stringify(status.graph)).not.toContain(input.body)
  })
})
