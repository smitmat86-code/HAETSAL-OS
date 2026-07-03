// tests/2.1-retain.test.ts
// Retain pipeline integration tests — canonical governed write path.
// Verifies: dedup, canonical D1 trail, encrypted R2 archive, governance receipt.
// Hindsight write path severed in mission Phase 1; retains never touch Hindsight.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { retainContent } from '../src/services/ingestion/retain'
import { computeDedupHash, checkDedup } from '../src/services/ingestion/dedup'
import { inferDomain, inferMemoryType } from '../src/services/ingestion/domain'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { installCanonicalMemoryTestStore } from '../src/services/canonical-postgres'
import type { IngestionArtifact } from '../src/types/ingestion'

installCanonicalMemoryTestStore(env)

// Create test tenant in D1 before retain tests (FK constraint)
beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind('test-tenant-retain', now, now, 'hindsight-test-tenant-retain', now).run()
  const kekBytes = crypto.getRandomValues(new Uint8Array(32))
  await env.KV_SESSION.put(
    'cron_kek:test-tenant-retain',
    btoa(String.fromCharCode(...kekBytes)),
    { expirationTtl: 60 * 60 * 24 },
  )
  await env.D1_US.prepare(
    `UPDATE tenants
     SET cron_kek_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(now + (24 * 60 * 60 * 1000), now, 'test-tenant-retain').run()
})

// Helper: derive a test TMK for encryption
async function deriveTestTmk(): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('test-key-material'),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('test-salt'),
      info: new TextEncoder().encode('test-info'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function makeArtifact(overrides: Partial<IngestionArtifact> = {}): IngestionArtifact {
  return {
    tenantId: 'test-tenant-retain',
    source: 'mcp_retain',
    content: `Test content ${crypto.randomUUID()}`,
    occurredAt: Date.now(),
    ...overrides,
  }
}

function makeSeveredTestEnv() {
  const hindsightFetch = vi.fn(async () => {
    throw new Error('Hindsight must not be called by the retain pipeline (write path severed)')
  })
  const testEnv = {
    ...env,
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT: { fetch: hindsightFetch },
  } as unknown as typeof env
  return { testEnv, hindsightFetch }
}

describe('dedup', () => {
  it('computes deterministic hash for same source + content', async () => {
    const h1 = await computeDedupHash('sms', 'Hello World')
    const h2 = await computeDedupHash('sms', 'Hello World')
    expect(h1).toBe(h2)
  })

  it('produces different hashes for different sources', async () => {
    const h1 = await computeDedupHash('sms', 'Hello')
    const h2 = await computeDedupHash('gmail', 'Hello')
    expect(h1).not.toBe(h2)
  })

  it('normalizes whitespace for dedup', async () => {
    const h1 = await computeDedupHash('sms', 'Hello   World')
    const h2 = await computeDedupHash('sms', 'Hello World')
    expect(h1).toBe(h2)
  })

  it('checkDedup returns false for new content', async () => {
    const hash = await computeDedupHash('sms', `unique-${crypto.randomUUID()}`)
    const isDup = await checkDedup(hash, 'test-tenant', env)
    expect(isDup).toBe(false)
  })
})

describe('domain inference', () => {
  it('infers career domain from work-related content', () => {
    expect(inferDomain('Had a meeting with my manager about the project deadline')).toBe('career')
  })

  it('infers health domain from health content', () => {
    expect(inferDomain('Went to the doctor for medication review and therapy')).toBe('health')
  })

  it('defaults to general for unrecognized content', () => {
    expect(inferDomain('The sky is blue today')).toBe('general')
  })

  it('infers episodic memory type by default', () => {
    expect(inferMemoryType('any content')).toBe('episodic')
  })

  it('respects explicit memory type', () => {
    expect(inferMemoryType('any content', 'semantic')).toBe('semantic')
  })
})

describe('retainContent pipeline (canonical-only)', () => {
  it('retains content, creates the D1 ingestion trail, and never calls Hindsight', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact()
    const { testEnv, hindsightFetch } = makeSeveredTestEnv()

    const result = await retainContent(artifact, tmk, testEnv)

    expect(result).not.toBeNull()
    expect(result!.memoryId).toBeTruthy()
    expect(result!.memoryId).toBe(result!.canonicalOperationId)
    expect(result!.salienceTier).toBeGreaterThanOrEqual(1)
    expect(result!.dedupHash).toBeTruthy()
    expect(hindsightFetch).not.toHaveBeenCalled()

    // Verify ingestion_events row (load-bearing for dedup)
    const event = await testEnv.D1_US.prepare(
      `SELECT * FROM ingestion_events WHERE dedup_hash = ?`,
    ).bind(result!.dedupHash).first()
    expect(event).not.toBeNull()
    expect(event!.tenant_id).toBe('test-tenant-retain')
    expect(event!.memory_id).toBe(result!.canonicalOperationId)
    expect(event!.r2_key).toBeTruthy()

    // Verify canonical memory_audit row
    const audit = await testEnv.D1_US.prepare(
      `SELECT * FROM memory_audit WHERE memory_id = ? AND operation = 'memory.capture.accepted'`,
    ).bind(result!.canonicalCaptureId).first()
    expect(audit).not.toBeNull()
  })

  it('returns a governance receipt with evidence-grade defaults', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({
      content: `governance-test-${crypto.randomUUID()}`,
      memoryType: 'episodic',
      governance: { authorKind: 'agent', agentIdentity: 'test_agent' },
    })
    const { testEnv } = makeSeveredTestEnv()

    const result = await retainContent(artifact, tmk, testEnv)

    expect(result).not.toBeNull()
    expect(result!.governance?.memoryClass).toBe('episode')
    expect(result!.governance?.trustState).toBe('evidence')
    expect(result!.governance?.usePolicy).toBe('can_use_as_evidence')
    expect(result!.governance?.authorKind).toBe('agent')
    expect(result!.governance?.agentIdentity).toBe('test_agent')
  })

  it('returns null on dedup hit (second identical artifact)', async () => {
    const tmk = await deriveTestTmk()
    const content = `dedup-test-${crypto.randomUUID()}`
    const artifact = makeArtifact({ content })
    const { testEnv } = makeSeveredTestEnv()

    // First retain — should succeed
    const first = await retainContent(artifact, tmk, testEnv)
    expect(first).not.toBeNull()

    // Second retain with same content — dedup hit, returns null
    const second = await retainContent(artifact, tmk, testEnv)
    expect(second).toBeNull()
  })

  it('writes encrypted content to the R2 archive', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `stone-test-${crypto.randomUUID()}` })
    const { testEnv } = makeSeveredTestEnv()

    const result = await retainContent(artifact, tmk, testEnv)
    expect(result).not.toBeNull()

    const event = await testEnv.D1_US.prepare(
      `SELECT r2_key FROM ingestion_events WHERE dedup_hash = ?`,
    ).bind(result!.dedupHash).first<{ r2_key: string }>()
    expect(event?.r2_key).toBeTruthy()

    // Verify R2 object exists at the archival key and is not plaintext
    const r2Object = await testEnv.R2_ARTIFACTS.get(event!.r2_key)
    expect(r2Object).not.toBeNull()
    const storedContent = await r2Object!.text()
    expect(storedContent).not.toContain(artifact.content)
  })

  it('accepts pre-encrypted archival content when no TMK is available', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `pre-encrypted-test-${crypto.randomUUID()}` })
    const contentEncrypted = await encryptContentForArchive(artifact.content, tmk)
    const { testEnv } = makeSeveredTestEnv()

    const result = await retainContent(artifact, null, testEnv, undefined, {
      contentEncrypted,
    })

    expect(result).not.toBeNull()
    const event = await testEnv.D1_US.prepare(
      `SELECT r2_key FROM ingestion_events WHERE dedup_hash = ?`,
    ).bind(result!.dedupHash).first<{ r2_key: string }>()
    const r2Object = await testEnv.R2_ARTIFACTS.get(event!.r2_key)
    expect(r2Object).not.toBeNull()
    expect(await r2Object!.text()).toBe(contentEncrypted)
  })

  it('scores salience correctly for mcp_retain source (Tier 3)', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ source: 'mcp_retain' })
    const { testEnv } = makeSeveredTestEnv()

    const result = await retainContent(artifact, tmk, testEnv)
    expect(result).not.toBeNull()
    expect(result!.salienceTier).toBe(3)
  })

  it('does not create hindsight_operations rows for new retains', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `no-hindsight-ops-${crypto.randomUUID()}` })
    const { testEnv } = makeSeveredTestEnv()

    const before = await testEnv.D1_US.prepare(
      `SELECT COUNT(*) AS c FROM hindsight_operations WHERE tenant_id = 'test-tenant-retain'`,
    ).first<{ c: number }>()
    const result = await retainContent(artifact, tmk, testEnv)
    const after = await testEnv.D1_US.prepare(
      `SELECT COUNT(*) AS c FROM hindsight_operations WHERE tenant_id = 'test-tenant-retain'`,
    ).first<{ c: number }>()

    expect(result).not.toBeNull()
    expect(after!.c).toBe(before!.c)
  })
})
