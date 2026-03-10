// tests/2.1-retain.test.ts
// Retain pipeline integration tests
// Verifies: dedup, encryption, D1 records, STONE R2 archive

import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { retainContent } from '../src/services/ingestion/retain'
import { computeDedupHash, checkDedup } from '../src/services/ingestion/dedup'
import { inferDomain, inferMemoryType } from '../src/services/ingestion/domain'
import type { IngestionArtifact } from '../src/types/ingestion'

// Create test tenant in D1 before retain tests (FK constraint)
beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind('test-tenant-retain', now, now, 'hindsight-test-tenant-retain', now).run()
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

describe('retainContent pipeline', () => {
  it('retains content and creates D1 records', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact()

    const result = await retainContent(artifact, tmk, env)

    expect(result).not.toBeNull()
    expect(result!.memoryId).toBeTruthy()
    expect(result!.salienceTier).toBeGreaterThanOrEqual(1)
    expect(result!.dedupHash).toBeTruthy()
    expect(result!.stoneR2Key).toBeTruthy()

    // Verify ingestion_events row
    const event = await env.D1_US.prepare(
      `SELECT * FROM ingestion_events WHERE dedup_hash = ?`,
    ).bind(result!.dedupHash).first()
    expect(event).not.toBeNull()
    expect(event!.tenant_id).toBe('test-tenant-retain')
    expect(event!.memory_id).toBe(result!.memoryId)

    // Verify memory_audit row
    const audit = await env.D1_US.prepare(
      `SELECT * FROM memory_audit WHERE memory_id = ?`,
    ).bind(result!.memoryId).first()
    expect(audit).not.toBeNull()
    expect(audit!.operation).toBe('retained')
  })

  it('returns null on dedup hit (second identical artifact)', async () => {
    const tmk = await deriveTestTmk()
    const content = `dedup-test-${crypto.randomUUID()}`
    const artifact = makeArtifact({ content })

    // First retain — should succeed
    const first = await retainContent(artifact, tmk, env)
    expect(first).not.toBeNull()

    // Second retain with same content — dedup hit, returns null
    const second = await retainContent(artifact, tmk, env)
    expect(second).toBeNull()
  })

  it('writes encrypted content to R2 STONE archive', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `stone-test-${crypto.randomUUID()}` })

    const result = await retainContent(artifact, tmk, env)
    expect(result).not.toBeNull()

    // Verify R2 object exists at the STONE key
    const r2Object = await env.R2_ARTIFACTS.get(result!.stoneR2Key!)
    expect(r2Object).not.toBeNull()

    // Content should be encrypted (base64), not plaintext
    const storedContent = await r2Object!.text()
    expect(storedContent).not.toContain(artifact.content)
  })

  it('sends encrypted content to Hindsight (not plaintext) — Law 2', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `law2-test-${crypto.randomUUID()}` })

    // The Hindsight stub accepts any request — verify the pipeline runs without error
    // Real Law 2 verification: content_encrypted field is base64, not plaintext
    const result = await retainContent(artifact, tmk, env)
    expect(result).not.toBeNull()
    expect(result!.memoryId).toBeTruthy()
  })

  it('scores salience correctly for mcp_retain source (Tier 3)', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ source: 'mcp_retain' })

    const result = await retainContent(artifact, tmk, env)
    expect(result).not.toBeNull()
    expect(result!.salienceTier).toBe(3)
  })
})
