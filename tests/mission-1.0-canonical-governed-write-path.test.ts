// Mission Phase 1: canonical governed write path contract tests.
// Every capture carries a provenance envelope + epistemic class + trust state
// + use policy; an event ledger row is recorded; the Hindsight write path is gone.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { captureThroughCanonicalPipeline } from '../src/services/canonical-capture-pipeline'
import { resolveCaptureGovernance } from '../src/services/canonical-governance'
import { getCanonicalMemoryStore, installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { CanonicalPipelineCaptureInput } from '../src/types/canonical-capture-pipeline'
import { createGraphitiContainerTestEnv } from './support/graphiti-test-env'

const SUITE_ID = crypto.randomUUID()
const TENANT_ID = `test-tenant-mission-10-${SUITE_ID}`

installCanonicalMemoryTestStore(env)

async function deriveTestTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`mission-10-${SUITE_ID}`), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new TextEncoder().encode('mission-10-salt'),
      info: new TextEncoder().encode('mission-10-info'),
    },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

function createWriteTestEnv() {
  const { testEnv } = createGraphitiContainerTestEnv()
  const hindsightFetch = vi.fn(async () => {
    throw new Error('Hindsight dispatch must never run on the governed write path')
  })
  return {
    hindsightFetch,
    testEnv: {
      ...testEnv,
      WORKER_DOMAIN: 'haetsalos.test',
      HINDSIGHT: { fetch: hindsightFetch },
    } as typeof env,
  }
}

async function makeInput(suffix: string, governance?: CanonicalPipelineCaptureInput['governance']): Promise<CanonicalPipelineCaptureInput> {
  const tmk = await deriveTestTmk()
  const body = `Governed write fixture ${suffix}.\n\nMatt met Alice about the Atlas launch.`
  return {
    tenantId: TENANT_ID,
    sourceSystem: 'notes',
    sourceRef: `mission-10-${suffix}`,
    scope: 'projects',
    title: `Governed write ${suffix}`,
    body,
    bodyEncrypted: await encryptContentForArchive(body, tmk),
    capturedAt: Date.UTC(2026, 6, 2),
    governance,
  }
}

beforeAll(async () => {
  await ensureTenant(TENANT_ID)
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('mission 1.0 — governance resolution rules', () => {
  const base = { sourceSystem: 'notes', scope: 'projects' }

  it('defaults non-user authors to evidence + can_use_as_evidence', () => {
    const decision = resolveCaptureGovernance({ ...base, authorKind: 'agent', agentIdentity: 'chief_of_staff' })
    expect(decision.trustState).toBe('evidence')
    expect(decision.usePolicy).toBe('can_use_as_evidence')
    expect(decision.memoryClass).toBe('raw_source')
    expect(decision.downgraded).toBeNull()
  })

  it('maps legacy memory types deterministically', () => {
    expect(resolveCaptureGovernance({ ...base, legacyMemoryType: 'episodic' }).memoryClass).toBe('episode')
    expect(resolveCaptureGovernance({ ...base, legacyMemoryType: 'semantic' }).memoryClass).toBe('claim')
    expect(resolveCaptureGovernance({ ...base, legacyMemoryType: 'world' }).memoryClass).toBe('observation')
  })

  it('downgrades agent-claimed facts to claims with a recorded reason', () => {
    const decision = resolveCaptureGovernance({ ...base, authorKind: 'agent', memoryClass: 'fact' })
    expect(decision.memoryClass).toBe('claim')
    expect(decision.downgraded?.requestedClass).toBe('fact')
  })

  it('downgrades protected trust states and instruction-grade policy for agents', () => {
    const decision = resolveCaptureGovernance({
      ...base,
      authorKind: 'external_client',
      trustState: 'user_confirmed',
      usePolicy: 'can_use_as_instruction',
    })
    expect(decision.trustState).toBe('evidence')
    expect(decision.usePolicy).toBe('can_use_as_evidence')
    expect(decision.downgraded).not.toBeNull()
  })

  it('lets user authorship carry user_confirmed trust', () => {
    const decision = resolveCaptureGovernance({ ...base, authorKind: 'user' })
    expect(decision.trustState).toBe('user_confirmed')
  })

  it('rejects procedure memories from any identity except the consolidation cron (Law 3)', () => {
    expect(() => resolveCaptureGovernance({ ...base, authorKind: 'agent', memoryClass: 'procedure' }))
      .toThrow(/Law 3/)
    const allowed = resolveCaptureGovernance({
      ...base, authorKind: 'cron', agentIdentity: 'consolidation_cron', memoryClass: 'procedure',
    })
    expect(allowed.memoryClass).toBe('procedure')
  })

  it('rejects out-of-range confidence', () => {
    expect(() => resolveCaptureGovernance({ ...base, confidence: 1.5 })).toThrow(/confidence/i)
  })
})

describe('mission 1.0 — governed canonical capture', () => {
  it('persists the provenance envelope, event ledger row, and chunk text', async () => {
    const { hindsightFetch, testEnv } = createWriteTestEnv()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await makeInput('envelope', {
      authorKind: 'agent',
      agentIdentity: 'chief_of_staff',
      modelRuntime: 'workers-ai/llama-3.3-70b',
      confidence: 0.8,
      legacyMemoryType: 'episodic',
      provenanceNote: 'agent session close',
    })

    const result = await captureThroughCanonicalPipeline(input, testEnv, TENANT_ID)
    const store = getCanonicalMemoryStore(testEnv)
    const capture = await store.getCapture(TENANT_ID, result.capture.captureId)
    const events = await store.listRecentEvents(TENANT_ID, 50)
    const captureEvent = events.find((event) => event.capture_id === result.capture.captureId)

    expect(capture?.memory_class).toBe('episode')
    expect(capture?.trust_state).toBe('evidence')
    expect(capture?.use_policy).toBe('can_use_as_evidence')
    expect(capture?.author_kind).toBe('agent')
    expect(capture?.agent_identity).toBe('chief_of_staff')
    expect(capture?.model_runtime).toBe('workers-ai/llama-3.3-70b')
    expect(capture?.confidence).toBe(0.8)
    expect(capture?.retention).toBe('standard')
    expect(capture?.provenance_note).toBe('agent session close')
    expect(result.capture.governance.memoryClass).toBe('episode')
    expect(result.capture.governance.trustState).toBe('evidence')
    expect(captureEvent?.event_type).toBe('memory.captured')
    expect(captureEvent?.actor_kind).toBe('agent')
    expect(JSON.parse(captureEvent?.detail_json ?? '{}').trustState).toBe('evidence')
    expect(hindsightFetch).not.toHaveBeenCalled()
  })

  it('enforces evidence-only trust on the full pipeline for agent writes that claim more', async () => {
    const { testEnv } = createWriteTestEnv()
    vi.spyOn(testEnv.QUEUE_BULK, 'send').mockResolvedValue(undefined as never)
    const input = await makeInput('downgrade', {
      authorKind: 'external_client',
      agentIdentity: 'claude-code',
      memoryClass: 'fact',
      trustState: 'trusted_import',
      usePolicy: 'can_use_as_instruction',
    })

    const result = await captureThroughCanonicalPipeline(input, testEnv, TENANT_ID)
    const capture = await getCanonicalMemoryStore(testEnv).getCapture(TENANT_ID, result.capture.captureId)

    expect(capture?.memory_class).toBe('claim')
    expect(capture?.trust_state).toBe('evidence')
    expect(capture?.use_policy).toBe('can_use_as_evidence')
    expect(capture?.governance_downgraded_json).toBeTruthy()
    expect(result.capture.governance.downgraded?.reason).toMatch(/promotion|review|user/)
  })
})
