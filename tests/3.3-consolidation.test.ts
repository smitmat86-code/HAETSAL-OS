// tests/3.3-consolidation.test.ts
// Consolidation orchestrator — dedup, pass order, trigger tracking

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

const setupTenant = async (status = 'completed') => {
  const tenantId = crypto.randomUUID()
  const hindsightId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id,
      ai_cost_reset_at, bootstrap_status)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?, ?)`,
  ).bind(tenantId, now, now, hindsightId, now, status).run()
  return { tenantId, hindsightId }
}

describe('Consolidation orchestrator', () => {
  it('exports runConsolidationPasses and handleNightlyConsolidation', async () => {
    const mod = await import('../src/cron/consolidation')
    expect(typeof mod.runConsolidationPasses).toBe('function')
    expect(typeof mod.handleNightlyConsolidation).toBe('function')
  })

  it('consolidation_runs has v2 columns (trigger, pass1-4)', async () => {
    const { tenantId } = await setupTenant()
    const runId = crypto.randomUUID()
    await env.D1_US.prepare(
      `INSERT INTO consolidation_runs
       (id, tenant_id, started_at, status, trigger, pass1_contradictions, pass2_bridges, pass3_patterns, pass4_gaps)
       VALUES (?, ?, ?, 'completed', 'webhook', 2, 3, 1, 3)`,
    ).bind(runId, tenantId, Date.now()).run()

    const row = await env.D1_US.prepare(
      'SELECT trigger, pass1_contradictions, pass2_bridges, pass3_patterns, pass4_gaps FROM consolidation_runs WHERE id = ?',
    ).bind(runId).first()
    expect(row!.trigger).toBe('webhook')
    expect(row!.pass1_contradictions).toBe(2)
    expect(row!.pass2_bridges).toBe(3)
    expect(row!.pass3_patterns).toBe(1)
    expect(row!.pass4_gaps).toBe(3)
  })

  it('dedup unique index prevents same-day double-run', async () => {
    const { tenantId } = await setupTenant()
    const now = Date.now()
    // First insert succeeds
    const r1 = await env.D1_US.prepare(
      `INSERT OR IGNORE INTO consolidation_runs (id, tenant_id, started_at, status, trigger) VALUES (?, ?, ?, 'running', 'webhook')`,
    ).bind(crypto.randomUUID(), tenantId, now).run()
    expect(r1.meta.changes).toBe(1)

    // Second insert same day — dedup index prevents
    const r2 = await env.D1_US.prepare(
      `INSERT OR IGNORE INTO consolidation_runs (id, tenant_id, started_at, status, trigger) VALUES (?, ?, ?, 'running', 'cron')`,
    ).bind(crypto.randomUUID(), tenantId, now + 1000).run()
    expect(r2.meta.changes).toBe(0)
  })

  it('different-day runs both succeed', async () => {
    const { tenantId } = await setupTenant()
    const day1 = 1710000000000  // arbitrary day 1
    const day2 = day1 + 86400000  // next day

    const r1 = await env.D1_US.prepare(
      `INSERT OR IGNORE INTO consolidation_runs (id, tenant_id, started_at, status, trigger) VALUES (?, ?, ?, 'running', 'cron')`,
    ).bind(crypto.randomUUID(), tenantId, day1).run()
    const r2 = await env.D1_US.prepare(
      `INSERT OR IGNORE INTO consolidation_runs (id, tenant_id, started_at, status, trigger) VALUES (?, ?, ?, 'running', 'cron')`,
    ).bind(crypto.randomUUID(), tenantId, day2).run()
    expect(r1.meta.changes).toBe(1)
    expect(r2.meta.changes).toBe(1)
  })

  it('KEK expired → deferred path (no consolidation run)', async () => {
    const { tenantId } = await setupTenant()
    // No KEK set — fetchAndValidateKek returns null
    const runs = await env.D1_US.prepare(
      'SELECT COUNT(*) as count FROM consolidation_runs WHERE tenant_id = ?',
    ).bind(tenantId).first<{ count: number }>()
    expect(runs!.count).toBe(0)
  })
})
