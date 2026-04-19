import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { getHindsightMemoryOpsSnapshot } from '../src/services/hindsight-ops'

const TEST_SUB = 'phase14-memory-audit-test-user'

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
          return new Response(JSON.stringify({ items: [] }), {
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
  } as typeof env
}

async function ensureTenant(tenantId: string): Promise<{ sub: string; tenantId: string }> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `bank-${tenantId}`, now).run()
  return { sub: TEST_SUB, tenantId }
}
describe('1.4a Memory Audit Snapshot', () => {
  it('returns a tenant-scoped hindsight memory ops snapshot', async () => {
    const ctx = await ensureTenant(`phase14-memory-audit-${crypto.randomUUID()}`)
    const now = Date.now()

    await env.D1_US.batch([
      env.D1_US.prepare(
        `INSERT INTO hindsight_operations
         (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
          salience_tier, dedup_hash, stone_r2_key, operation_type, status, requested_at,
          created_at, updated_at, available_at, availability_source, availability_last_checked_at)
         VALUES (?, ?, ?, ?, 'mcp_retain', 'user_authored', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
                 'pending', ?, ?, ?, ?, 'document', ?)`,
      ).bind(
        'op-audit-pending',
        ctx.tenantId,
        `bank-${ctx.tenantId}`,
        'doc-audit-pending',
        'dedup-audit-pending',
        now - 5_000,
        now - 5_000,
        now - 2_000,
        now - 1_000,
        now - 1_000,
      ),
      env.D1_US.prepare(
        `INSERT INTO hindsight_operations
         (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
          salience_tier, dedup_hash, stone_r2_key, operation_type, status, requested_at,
          created_at, updated_at, completed_at, last_checked_at)
         VALUES (?, ?, ?, ?, 'mcp_retain', 'user_authored', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
                 'completed', ?, ?, ?, ?, ?)`,
      ).bind(
        'op-audit-completed',
        ctx.tenantId,
        `bank-${ctx.tenantId}`,
        'doc-audit-completed',
        'dedup-audit-completed',
        now - 20_000,
        now - 20_000,
        now - 10_000,
        now - 10_000,
        now - 10_000,
      ),
    ])

    const body = await getHindsightMemoryOpsSnapshot(makeWebhookEnv(), ctx.tenantId) as {
      summary: {
        totalCount: number
        pendingCount: number
        availablePendingCount: number
        completedCount: number
        failedCount: number
        webhookHealth: { status: string; enabled: number }
      }
      recent: Array<{ operationId: string; queueState: string }>
    }

    expect(body.summary.totalCount).toBe(2)
    expect(body.summary.pendingCount).toBe(1)
    expect(body.summary.availablePendingCount).toBe(1)
    expect(body.summary.completedCount).toBe(1)
    expect(body.summary.failedCount).toBe(0)
    expect(['missing', 'unknown']).toContain(body.summary.webhookHealth.status)
    if (body.summary.webhookHealth.status === 'missing') {
      expect(body.summary.webhookHealth.enabled).toBe(0)
    }
    expect(body.recent.some((row) => row.operationId === 'op-audit-pending' && row.queueState === 'available')).toBe(true)
    expect(body.recent.some((row) => row.operationId === 'op-audit-completed' && row.queueState === 'completed')).toBe(true)
  })
})
