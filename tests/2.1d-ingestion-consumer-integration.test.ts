import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { computeDedupHash } from '../src/services/ingestion/dedup'
import { encryptContentForArchive } from '../src/services/ingestion/encryption'
import { handleIngestionBatch } from '../src/workers/ingestion/consumer'
import type { IngestionQueueMessage } from '../src/types/ingestion'

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind('test-tenant-queue', now, now, 'hindsight-test-tenant-queue', now).run()
})

async function deriveTestTmk(): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('queue-test-key-material'),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('queue-test-salt'),
      info: new TextEncoder().encode('queue-test-info'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function makeMessage(body: IngestionQueueMessage) {
  return {
    id: crypto.randomUUID(),
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: () => {},
    retry: () => {},
  } as unknown as Message<IngestionQueueMessage>
}

function makeEnvWithHindsightStub() {
  return {
    ...env,
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
          const request = input instanceof Request
            ? input
            : new Request(input.toString(), init)
          await request.clone().json()
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
}

describe('2.1d ingestion consumer integration', () => {
  it('processes retain_artifact and writes D1 ingestion trail', async () => {
    const content = `queue-integration-${crypto.randomUUID()}`
    const tmk = await deriveTestTmk()
    const contentEncrypted = await encryptContentForArchive(content, tmk)
    const dedupHash = await computeDedupHash('mcp_retain', content)
    const testEnv = makeEnvWithHindsightStub()
    const message = makeMessage({
      type: 'retain_artifact',
      tenantId: 'test-tenant-queue',
      payload: {
        requestId: crypto.randomUUID(),
        artifact: {
          source: 'mcp_retain',
          content,
          occurredAt: Date.now(),
          memoryType: 'episodic',
          domain: 'career',
          provenance: 'mcp_retain',
        },
        contentEncrypted,
      },
      enqueuedAt: Date.now(),
    })

    await handleIngestionBatch(
      {
        queue: 'brain-priority-high',
        messages: [message],
        retryAll: () => {},
        ackAll: () => {},
      } as unknown as MessageBatch<IngestionQueueMessage>,
      testEnv,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    )

    const event = await testEnv.D1_US.prepare(
      `SELECT tenant_id, source, memory_id, dedup_hash
       FROM ingestion_events
       WHERE tenant_id = ? AND dedup_hash = ?`,
    ).bind('test-tenant-queue', dedupHash).first<{
      tenant_id: string
      source: string
      memory_id: string
      dedup_hash: string
    }>()
    expect(event).not.toBeNull()
    expect(event!.source).toBe('mcp_retain')
    expect(event!.memory_id).toContain('test-tenant-queue:mcp_retain:')

    const audit = await testEnv.D1_US.prepare(
      `SELECT operation, memory_id
       FROM memory_audit
       WHERE tenant_id = ? AND memory_id = ?`,
    ).bind('test-tenant-queue', event!.memory_id).first<{
      operation: string
      memory_id: string
    }>()
    expect(audit).not.toBeNull()
    expect(audit!.operation).toBe('retained')
  })
})
