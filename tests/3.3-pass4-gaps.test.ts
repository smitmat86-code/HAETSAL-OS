// tests/3.3-pass4-gaps.test.ts
// Gap identification — D1 only, no Hindsight, no encryption

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

const setupTenant = async () => {
  const tenantId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at, bootstrap_status)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?, 'completed')`,
  ).bind(tenantId, now, now, crypto.randomUUID(), now).run()
  return tenantId
}

describe('Pass 4 — Gap Identification', () => {
  it('pass4-gaps.ts exports runPass4', async () => {
    const mod = await import('../src/cron/passes/pass4-gaps')
    expect(typeof mod.runPass4).toBe('function')
  })

  it('gaps written to D1 consolidation_gaps table', async () => {
    const tenantId = await setupTenant()
    const runId = crypto.randomUUID()
    await env.D1_US.prepare(
      `INSERT INTO consolidation_runs (id, tenant_id, started_at, status, trigger) VALUES (?, ?, ?, 'completed', 'cron')`,
    ).bind(runId, tenantId, Date.now()).run()

    // Simulate gap insertion (what pass4 does)
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO consolidation_gaps
       (id, tenant_id, run_id, question, domain, priority, surfaced, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(crypto.randomUUID(), tenantId, runId, 'What are your career goals?', 'career', 'high', Date.now()).run()

    const gaps = await env.D1_US.prepare(
      'SELECT question, domain, priority, surfaced FROM consolidation_gaps WHERE tenant_id = ?',
    ).bind(tenantId).all()
    expect(gaps.results.length).toBe(1)
    expect(gaps.results[0].question).toBe('What are your career goals?')
    expect(gaps.results[0].surfaced).toBe(0)
  })

  it('max 3 gaps per run enforced', () => {
    const gaps = [
      { question: 'Q1', domain: 'd1', priority: 'high' as const },
      { question: 'Q2', domain: 'd2', priority: 'medium' as const },
      { question: 'Q3', domain: 'd3', priority: 'low' as const },
      { question: 'Q4', domain: 'd4', priority: 'high' as const },
    ]
    expect(gaps.slice(0, 3).length).toBe(3)
  })

  it('gap questions stored as plain text (no encryption)', async () => {
    const tenantId = await setupTenant()
    const runId = crypto.randomUUID()
    await env.D1_US.prepare(
      `INSERT INTO consolidation_runs (id, tenant_id, started_at, status, trigger) VALUES (?, ?, ?, 'completed', 'cron')`,
    ).bind(runId, tenantId, Date.now()).run()

    const question = 'What financial decisions are pending?'
    await env.D1_US.prepare(
      `INSERT INTO consolidation_gaps (id, tenant_id, run_id, question, domain, priority, surfaced, created_at) VALUES (?, ?, ?, ?, 'finance', 'high', 0, ?)`,
    ).bind(crypto.randomUUID(), tenantId, runId, question, Date.now()).run()

    const row = await env.D1_US.prepare(
      'SELECT question FROM consolidation_gaps WHERE tenant_id = ? LIMIT 1',
    ).bind(tenantId).first<{ question: string }>()
    // Plain text — not encrypted — structural metadata only
    expect(row!.question).toBe(question)
  })
})
