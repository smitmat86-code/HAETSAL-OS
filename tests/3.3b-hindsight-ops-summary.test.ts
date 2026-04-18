import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  deriveQueueState,
  getHindsightMemoryOpsSnapshot,
  HINDSIGHT_PENDING_SLOW_MS,
  HINDSIGHT_PENDING_STUCK_MS,
} from '../src/services/hindsight-ops'

function makeWebhookEnv() {
  return {
    ...env,
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(input.toString())
        if (/^\/v1\/default\/banks\/[^/]+\/webhooks$/.test(url.pathname)) {
          return new Response(JSON.stringify({
            items: [{ url: 'https://example.com/hindsight', enabled: true }],
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

describe('3.3b hindsight ops summary', () => {
  beforeEach(async () => {
    await env.D1_US.exec('DELETE FROM memory_audit; DELETE FROM ingestion_events; DELETE FROM hindsight_operations; DELETE FROM tenants;')
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT INTO tenants
       (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind('tenant-summary-test', now, now, 'bank-summary-test', now).run()
  })

  it('derives queue states across pending, available, delayed, stuck, completed, failed', () => {
    const now = Date.now()
    expect(deriveQueueState({ status: 'completed', requested_at: now, available_at: null, slow_at: null, stuck_at: null }, now)).toBe('completed')
    expect(deriveQueueState({ status: 'failed', requested_at: now, available_at: null, slow_at: null, stuck_at: null }, now)).toBe('failed')
    expect(deriveQueueState({ status: 'pending', requested_at: now, available_at: now, slow_at: null, stuck_at: null }, now)).toBe('available')
    expect(deriveQueueState({ status: 'pending', requested_at: now - HINDSIGHT_PENDING_SLOW_MS - 1000, available_at: null, slow_at: null, stuck_at: null }, now)).toBe('delayed')
    expect(deriveQueueState({ status: 'pending', requested_at: now - HINDSIGHT_PENDING_STUCK_MS - 1000, available_at: null, slow_at: null, stuck_at: null }, now)).toBe('stuck')
    expect(deriveQueueState({ status: 'pending', requested_at: now, available_at: null, slow_at: null, stuck_at: null }, now)).toBe('pending')
  })

  it('returns a tenant-scoped ops snapshot with webhook health', async () => {
    const now = Date.now()
    await env.D1_US.batch([
      env.D1_US.prepare(
        `INSERT INTO hindsight_operations
         (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
          salience_tier, dedup_hash, stone_r2_key, operation_type, status, requested_at,
          created_at, updated_at, last_checked_at, available_at, availability_source,
          availability_last_checked_at)
         VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
                 'pending', ?, ?, ?, ?, ?, 'document', ?)`,
      ).bind(
        'op-summary-pending',
        'tenant-summary-test',
        'bank-summary-test',
        'doc-summary-pending',
        'dedup-summary-pending',
        now - 5_000,
        now - 5_000,
        now - 5_000,
        now,
        now,
        now,
      ),
      env.D1_US.prepare(
        `INSERT INTO hindsight_operations
         (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
          salience_tier, dedup_hash, stone_r2_key, operation_type, status, requested_at,
          created_at, updated_at, completed_at, last_checked_at, available_at, availability_source,
          availability_last_checked_at, slow_at)
         VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
                 'completed', ?, ?, ?, ?, ?, ?, 'operation_completed', ?, ?)`,
      ).bind(
        'op-summary-completed',
        'tenant-summary-test',
        'bank-summary-test',
        'doc-summary-completed',
        'dedup-summary-completed',
        now - 20_000,
        now - 20_000,
        now - 2_000,
        now - 2_000,
        now - 2_000,
        now - 2_000,
        now - 2_000,
        now - 15_000,
      ),
      env.D1_US.prepare(
        `INSERT INTO hindsight_operations
         (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
          salience_tier, dedup_hash, stone_r2_key, operation_type, status, error_message, requested_at,
          created_at, updated_at, completed_at, last_checked_at, slow_at, stuck_at)
         VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
                 'failed', 'provider timeout', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'op-summary-failed',
        'tenant-summary-test',
        'bank-summary-test',
        'doc-summary-failed',
        'dedup-summary-failed',
        now - 30_000,
        now - 30_000,
        now - 10_000,
        now - 10_000,
        now - 10_000,
        now - 25_000,
        now - 12_000,
      ),
    ])

    const snapshot = await getHindsightMemoryOpsSnapshot(makeWebhookEnv(), 'tenant-summary-test')

    expect(snapshot.summary.totalCount).toBe(3)
    expect(snapshot.summary.pendingCount).toBe(1)
    expect(snapshot.summary.availablePendingCount).toBe(1)
    expect(snapshot.summary.completedCount).toBe(1)
    expect(snapshot.summary.failedCount).toBe(1)
    expect(snapshot.summary.bankId).toBe('bank-summary-test')
    expect(snapshot.summary.webhookHealth.status).toBe('ok')
    expect(snapshot.summary.webhookHealth.enabled).toBe(1)
    expect(snapshot.recent.length).toBe(3)
    expect(snapshot.recent[0]?.queueState).toBe('available')
  })
})
