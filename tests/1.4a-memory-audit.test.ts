import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { deriveTenantId } from '../src/middleware/auth'
import { installCfAccessMock } from './support/cf-access'

const TEST_AUD = 'test-aud-brain-access'

async function ensureTenant(sub: string): Promise<{ sub: string; tenantId: string }> {
  const tenantId = await deriveTenantId(sub, TEST_AUD)
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `bank-${tenantId}`, now).run()
  return { sub, tenantId }
}

async function authorizedFetch(sub: string, path: string): Promise<Response> {
  const auth = await installCfAccessMock(sub)
  try {
    return await SELF.fetch(`http://localhost${path}`, {
      headers: {
        'CF-Access-Jwt-Assertion': auth.jwt,
      },
    })
  } finally {
    auth.restore()
  }
}

describe('1.4a Memory Audit Route', () => {
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

    const response = await authorizedFetch(ctx.sub, '/api/audit/memory')

    expect(response.status).toBe(200)
    const body = await response.json() as {
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
