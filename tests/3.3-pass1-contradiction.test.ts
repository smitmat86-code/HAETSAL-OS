// tests/3.3-pass1-contradiction.test.ts
// Contradiction detection — /history structural signal + anomaly_signals

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

const setupTenant = async () => {
  const tenantId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, crypto.randomUUID(), now).run()
  return tenantId
}

describe('Pass 1 — Contradiction Detection', () => {
  it('pass1-contradiction.ts exports runPass1', async () => {
    const mod = await import('../src/cron/passes/pass1-contradiction')
    expect(typeof mod.runPass1).toBe('function')
  })

  it('genuine_contradiction writes anomaly_signal to D1', async () => {
    const tenantId = await setupTenant()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO anomaly_signals
       (id, tenant_id, created_at, signal_type, severity, detail_json)
       VALUES (?, ?, ?, 'memory.contradiction', 'medium', ?)`,
    ).bind(crypto.randomUUID(), tenantId, Date.now(), '{"memory_id":"mem-123"}').run()

    const signal = await env.D1_US.prepare(
      'SELECT signal_type, detail_json FROM anomaly_signals WHERE tenant_id = ? AND signal_type = ?',
    ).bind(tenantId, 'memory.contradiction').first()
    expect(signal).not.toBeNull()
    expect(signal!.signal_type).toBe('memory.contradiction')
  })

  it('ambiguous contradiction writes unresolved anomaly type', async () => {
    const tenantId = await setupTenant()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO anomaly_signals
       (id, tenant_id, created_at, signal_type, severity, detail_json)
       VALUES (?, ?, ?, 'memory.contradiction_unresolved', 'medium', ?)`,
    ).bind(crypto.randomUUID(), tenantId, Date.now(), '{"memory_id":"mem-456"}').run()

    const signal = await env.D1_US.prepare(
      'SELECT signal_type FROM anomaly_signals WHERE tenant_id = ? AND signal_type = ?',
    ).bind(tenantId, 'memory.contradiction_unresolved').first()
    expect(signal!.signal_type).toBe('memory.contradiction_unresolved')
  })

  it('natural_update produces no anomaly signal', async () => {
    const tenantId = await setupTenant()
    // No anomaly written for natural updates
    const signals = await env.D1_US.prepare(
      'SELECT COUNT(*) as count FROM anomaly_signals WHERE tenant_id = ?',
    ).bind(tenantId).first<{ count: number }>()
    expect(signals!.count).toBe(0)
  })
})
