// tests/2.1-retain.test.ts
// Retain pipeline integration tests
// Verifies: dedup, plaintext Hindsight retain, D1 records, encrypted STONE R2 archive

import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { processCanonicalProjectionDispatch } from '../src/workers/ingestion/canonical-projection-consumer'
import { retainContent } from '../src/services/ingestion/retain'
import { computeDedupHash, checkDedup } from '../src/services/ingestion/dedup'
import { inferDomain, inferMemoryType } from '../src/services/ingestion/domain'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import type { IngestionArtifact } from '../src/types/ingestion'

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

function makeEnvWithHindsightStub(
  capture?: { bankIds: string[]; retainBodies?: unknown[] },
  options?: { immediateProjectionDispatch?: boolean },
) {
  const testEnv = {
    ...env,
    HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'false',
    WORKER_DOMAIN: 'brain.workers.dev',
    HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/mental-models$/.test(url.pathname) && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname) && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          capture?.bankIds.push(url.pathname.split('/')[4])
          const request = input instanceof Request
            ? input
            : new Request(input.toString(), init)
          capture?.retainBodies?.push(await request.clone().json())
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: false,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  } as unknown as typeof env
  if (options?.immediateProjectionDispatch) {
    testEnv.QUEUE_BULK.send = (async (message: {
      tenantId: string
      payload: Record<string, unknown>
    }) => {
      const pending: Promise<unknown>[] = []
      await processCanonicalProjectionDispatch(message.tenantId, message.payload, testEnv, {
        waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
      })
      await Promise.allSettled(pending)
    }) as typeof env.QUEUE_BULK.send
  }
  return testEnv
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
    const testEnv = makeEnvWithHindsightStub(undefined, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, tmk, testEnv)

    expect(result).not.toBeNull()
    expect(result!.memoryId).toBeTruthy()
    expect(result!.salienceTier).toBeGreaterThanOrEqual(1)
    expect(result!.dedupHash).toBeTruthy()
    expect(result!.stoneR2Key).toBeTruthy()

    // Verify ingestion_events row
    const event = await testEnv.D1_US.prepare(
      `SELECT * FROM ingestion_events WHERE dedup_hash = ?`,
    ).bind(result!.dedupHash).first()
    expect(event).not.toBeNull()
    expect(event!.tenant_id).toBe('test-tenant-retain')
    expect(event!.memory_id).toBe(result!.memoryId)

    // Verify memory_audit row
    const audit = await testEnv.D1_US.prepare(
      `SELECT * FROM memory_audit WHERE memory_id = ?`,
    ).bind(result!.memoryId).first()
    expect(audit).not.toBeNull()
    expect(audit!.operation).toBe('retained')
  })

  it('returns null on dedup hit (second identical artifact)', async () => {
    const tmk = await deriveTestTmk()
    const content = `dedup-test-${crypto.randomUUID()}`
    const artifact = makeArtifact({ content })
    const testEnv = makeEnvWithHindsightStub(undefined, { immediateProjectionDispatch: true })

    // First retain — should succeed
    const first = await retainContent(artifact, tmk, testEnv)
    expect(first).not.toBeNull()

    // Second retain with same content — dedup hit, returns null
    const second = await retainContent(artifact, tmk, testEnv)
    expect(second).toBeNull()
  })

  it('writes encrypted content to R2 STONE archive', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `stone-test-${crypto.randomUUID()}` })
    const testEnv = makeEnvWithHindsightStub(undefined, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, tmk, testEnv)
    expect(result).not.toBeNull()

    // Verify R2 object exists at the STONE key
    const r2Object = await testEnv.R2_ARTIFACTS.get(result!.stoneR2Key!)
    expect(r2Object).not.toBeNull()

    // Content should be encrypted (base64), not plaintext
    const storedContent = await r2Object!.text()
    expect(storedContent).not.toContain(artifact.content)
  })

  it('accepts pre-encrypted archival content when no TMK is available', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `pre-encrypted-test-${crypto.randomUUID()}` })
    const contentEncrypted = await encryptContentForArchive(artifact.content, tmk)
    const testEnv = makeEnvWithHindsightStub(undefined, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, null, testEnv, undefined, {
      contentEncrypted,
    })

    expect(result).not.toBeNull()
    const r2Object = await testEnv.R2_ARTIFACTS.get(result!.stoneR2Key!)
    expect(r2Object).not.toBeNull()
    expect(await r2Object!.text()).toBe(contentEncrypted)
  })

  it('uses a stable document-based memory reference for Hindsight retains', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `law2-test-${crypto.randomUUID()}` })
    const testEnv = makeEnvWithHindsightStub(undefined, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, tmk, testEnv)
    expect(result).not.toBeNull()
    expect(result!.memoryId).toBeTruthy()
    expect(result!.memoryId).toContain('test-tenant-retain:mcp_retain:')
  })

  it('resolves the stored hindsight bank id before writing to Hindsight', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `bank-id-test-${crypto.randomUUID()}` })
    const capture = { bankIds: [] as string[] }
    const testEnv = makeEnvWithHindsightStub(capture, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, tmk, testEnv)

    expect(result).not.toBeNull()
    expect(capture.bankIds).toContain('hindsight-test-tenant-retain')
    expect(capture.bankIds).not.toContain('test-tenant-retain')
  })

  it('normalizes Hindsight metadata values to strings', async () => {
    const tmk = await deriveTestTmk()
    const capture = { bankIds: [] as string[], retainBodies: [] as unknown[] }
    const artifact = makeArtifact({
      content: `metadata-test-${crypto.randomUUID()}`,
      metadata: { priority: 3, nested: { source: 'test' }, enabled: true },
    })
    const testEnv = makeEnvWithHindsightStub(capture, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, tmk, testEnv)

    expect(result).not.toBeNull()
    const body = capture.retainBodies[0] as {
      items: Array<{ metadata: Record<string, string> }>
    }
    expect(body.items[0].metadata.priority).toBe('3')
    expect(body.items[0].metadata.nested).toBe('{"source":"test"}')
    expect(body.items[0].metadata.enabled).toBe('true')
    expect(body.items[0].metadata.salience_tier).toMatch(/^[123]$/)
    expect(body.items[0].metadata.occurred_at_ms).toBe(String(artifact.occurredAt))
  })

  it('scores salience correctly for mcp_retain source (Tier 3)', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ source: 'mcp_retain' })
    const testEnv = makeEnvWithHindsightStub(undefined, { immediateProjectionDispatch: true })

    const result = await retainContent(artifact, tmk, testEnv)
    expect(result).not.toBeNull()
    expect(result!.salienceTier).toBe(3)
  })

  it('records async retain lifecycle in hindsight_operations', async () => {
    const tmk = await deriveTestTmk()
    const artifact = makeArtifact({ content: `async-op-test-${crypto.randomUUID()}` })
    const testEnv = makeEnvWithHindsightStub({
      bankIds: [],
      retainBodies: [],
    }, { immediateProjectionDispatch: true })
    testEnv.QUEUE_BULK.send = (async (message: {
      tenantId: string
      payload: Record<string, unknown>
    }) => {
      await processCanonicalProjectionDispatch(message.tenantId, message.payload, testEnv)
    }) as typeof env.QUEUE_BULK.send
    testEnv.HINDSIGHT = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/memories$/.test(url.pathname)) {
          const request = input instanceof Request
            ? input
            : new Request(input.toString(), init)
          await request.clone().json()
          return new Response(JSON.stringify({
            success: true,
            bank_id: url.pathname.split('/')[4],
            items_count: 1,
            async: true,
            operation_id: 'op-async-retain-test',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (/^\/v1\/default\/banks\/[^/]+\/operations\/[^/]+$/.test(url.pathname)) {
          return new Response(JSON.stringify({
            operation_id: 'op-async-retain-test',
            status: 'pending',
            operation_type: 'retain',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null,
            error_message: null,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    } as unknown as typeof env.HINDSIGHT

    const result = await retainContent(artifact, tmk, testEnv, undefined, {
      hindsightAsync: true,
    })

    expect(result).not.toBeNull()
    expect(result!.operationId).toBe(result!.canonicalOperationId)

    const row = await testEnv.D1_US.prepare(
      `SELECT operation_id, tenant_id, bank_id, source_document_id, status, dedup_hash
       FROM hindsight_operations
       WHERE operation_id = ?`,
    ).bind('op-async-retain-test').first<{
      operation_id: string
      tenant_id: string
      bank_id: string
      source_document_id: string
      status: string
      dedup_hash: string
    }>()

    expect(row).not.toBeNull()
    expect(row!.tenant_id).toBe('test-tenant-retain')
    expect(row!.status).toBe('pending')
    expect(row!.source_document_id).toContain('test-tenant-retain:mcp_retain:')

    const audit = await testEnv.D1_US.prepare(
      `SELECT operation, memory_id FROM memory_audit WHERE operation = 'retain_queued' AND memory_id = ?`,
    ).bind('op-async-retain-test').first()
    expect(audit).not.toBeNull()
  })
})
