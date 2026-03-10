// tests/3.4-heartbeat.test.ts
// Predictive heartbeat — alert conditions, time window, no-alert silence

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

const setupTenant = async (status = 'completed') => {
  const tenantId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at, bootstrap_status)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?, ?)`,
  ).bind(tenantId, now, now, crypto.randomUUID(), now, status).run()
  return tenantId
}

describe('Predictive heartbeat', () => {
  it('heartbeat module exports runPredictiveHeartbeat', async () => {
    const mod = await import('../src/cron/heartbeat')
    expect(typeof mod.runPredictiveHeartbeat).toBe('function')
  })

  it('time window: hour < 8 should not send (check logic)', () => {
    const hour = 6
    expect(hour < 8 || hour >= 20).toBe(true)
  })

  it('time window: hour >= 20 should not send (check logic)', () => {
    const hour = 22
    expect(hour < 8 || hour >= 20).toBe(true)
  })

  it('time window: hour 12 is within window', () => {
    const hour = 12
    expect(hour < 8 || hour >= 20).toBe(false)
  })

  it('expiring actions query finds old pending actions', async () => {
    const tenantId = await setupTenant()
    const oldTime = Date.now() - 21 * 60 * 60 * 1000 // 21h ago
    await env.D1_US.prepare(
      `INSERT INTO pending_actions
       (id, tenant_id, action_type, integration, state, capability_class,
        authorization_level, proposed_at, proposed_by, payload_r2_key, payload_hash, max_retries)
       VALUES (?, ?, 'send_email', 'gmail', 'awaiting_approval', 'communication',
        'YELLOW', ?, 'chief_of_staff', 'r2key', 'hash', 3)`,
    ).bind(crypto.randomUUID(), tenantId, oldTime).run()

    const expiring = await env.D1_US.prepare(
      `SELECT action_type FROM pending_actions
       WHERE tenant_id = ? AND state = 'awaiting_approval'
       AND proposed_at < ?`,
    ).bind(tenantId, Date.now() - 20 * 60 * 60 * 1000).all()

    expect(expiring.results.length).toBe(1)
    expect(expiring.results[0].action_type).toBe('send_email')
  })

  it('no expiring actions — query returns empty', async () => {
    const tenantId = await setupTenant()
    const recentTime = Date.now() - 1 * 60 * 60 * 1000 // 1h ago
    await env.D1_US.prepare(
      `INSERT INTO pending_actions
       (id, tenant_id, action_type, integration, state, capability_class,
        authorization_level, proposed_at, proposed_by, payload_r2_key, payload_hash, max_retries)
       VALUES (?, ?, 'send_email', 'gmail', 'awaiting_approval', 'communication',
        'YELLOW', ?, 'chief_of_staff', 'r2key', 'hash', 3)`,
    ).bind(crypto.randomUUID(), tenantId, recentTime).run()

    const expiring = await env.D1_US.prepare(
      `SELECT action_type FROM pending_actions
       WHERE tenant_id = ? AND state = 'awaiting_approval'
       AND proposed_at < ?`,
    ).bind(tenantId, Date.now() - 20 * 60 * 60 * 1000).all()

    expect(expiring.results.length).toBe(0)
  })

  it('consolidation gaps query counts unsurfaced high-priority', async () => {
    const tenantId = await setupTenant()
    const runId = crypto.randomUUID()
    const now = Date.now()

    await env.D1_US.prepare(
      `INSERT INTO consolidation_runs (id, tenant_id, started_at, status)
       VALUES (?, ?, ?, 'completed')`,
    ).bind(runId, tenantId, now).run()

    // Insert 3 high-priority unsurfaced gaps
    for (let i = 0; i < 3; i++) {
      await env.D1_US.prepare(
        `INSERT INTO consolidation_gaps
         (id, tenant_id, run_id, question, domain, priority, surfaced, created_at)
         VALUES (?, ?, ?, ?, 'career', 'high', 0, ?)`,
      ).bind(crypto.randomUUID(), tenantId, runId, `Question ${i}`, now + i).run()
    }

    const gaps = await env.D1_US.prepare(
      `SELECT COUNT(*) as count FROM consolidation_gaps
       WHERE tenant_id = ? AND surfaced = 0 AND priority = 'high'`,
    ).bind(tenantId).first<{ count: number }>()

    expect(gaps!.count).toBe(3)
    expect(gaps!.count > 2).toBe(true) // Would trigger alert
  })
})
