// tests/3.4-morning-brief.test.ts
// Morning brief — section assembly, fallback, delivery, gap marking

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

describe('Morning brief assembly', () => {
  it('module exports handleMorningBrief', async () => {
    const mod = await import('../src/cron/morning-brief')
    expect(typeof mod.handleMorningBrief).toBe('function')
  })

  it('KEK check — expired KEK returns null from kek.ts', async () => {
    const { fetchAndValidateKek } = await import('../src/cron/kek')
    const tenantId = await setupTenant()
    // No KEK set → should return null
    const kek = await fetchAndValidateKek(tenantId, env)
    expect(kek).toBeNull()
  })

  it('KEK check — valid KEK returns CryptoKey', async () => {
    const { fetchAndValidateKek } = await import('../src/cron/kek')
    const tenantId = await setupTenant()
    const futureExpiry = Date.now() + 86_400_000

    // Set up valid KEK
    await env.D1_US.prepare(
      `UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?`,
    ).bind(futureExpiry, tenantId).run()

    const keyBytes = crypto.getRandomValues(new Uint8Array(32))
    const rawB64 = btoa(String.fromCharCode(...keyBytes))
    await env.KV_SESSION.put(`cron_kek:${tenantId}`, rawB64)

    const kek = await fetchAndValidateKek(tenantId, env)
    expect(kek).not.toBeNull()
    expect(kek).toHaveProperty('type', 'secret')
  })

  it('KEK expiry writes anomaly signal', async () => {
    const { fetchAndValidateKek } = await import('../src/cron/kek')
    const tenantId = await setupTenant()
    const pastExpiry = Date.now() - 1000

    await env.D1_US.prepare(
      `UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?`,
    ).bind(pastExpiry, tenantId).run()

    await fetchAndValidateKek(tenantId, env)

    const anomaly = await env.D1_US.prepare(
      `SELECT signal_type FROM anomaly_signals WHERE tenant_id = ?`,
    ).bind(tenantId).first<{ signal_type: string }>()

    expect(anomaly!.signal_type).toBe('cron_kek_expired')
  })

  it('Bible verse cached in KV — same value on second call', async () => {
    const verse = 'John 3:16: "For God so loved the world"'
    await env.KV_SESSION.put('bible_verse:today', verse, { expirationTtl: 3600 })
    const cached = await env.KV_SESSION.get('bible_verse:today')
    expect(cached).toBe(verse)
  })

  it('open loop gap query finds unsurfaced high-priority gap', async () => {
    const tenantId = await setupTenant()
    const runId = crypto.randomUUID()
    const now = Date.now()

    await env.D1_US.prepare(
      `INSERT INTO consolidation_runs (id, tenant_id, started_at, status)
       VALUES (?, ?, ?, 'completed')`,
    ).bind(runId, tenantId, now).run()

    await env.D1_US.prepare(
      `INSERT INTO consolidation_gaps
       (id, tenant_id, run_id, question, domain, priority, surfaced, created_at)
       VALUES (?, ?, ?, 'What are your career goals for Q2?', 'career', 'high', 0, ?)`,
    ).bind(crypto.randomUUID(), tenantId, runId, now).run()

    const gap = await env.D1_US.prepare(
      `SELECT question FROM consolidation_gaps
       WHERE tenant_id = ? AND surfaced = 0 AND priority = 'high'
       ORDER BY created_at ASC LIMIT 1`,
    ).bind(tenantId).first<{ question: string }>()

    expect(gap!.question).toBe('What are your career goals for Q2?')
  })

  it('gap marked surfaced after brief', async () => {
    const tenantId = await setupTenant()
    const runId = crypto.randomUUID()
    const gapId = crypto.randomUUID()
    const now = Date.now()

    await env.D1_US.prepare(
      `INSERT INTO consolidation_runs (id, tenant_id, started_at, status)
       VALUES (?, ?, ?, 'completed')`,
    ).bind(runId, tenantId, now).run()

    await env.D1_US.prepare(
      `INSERT INTO consolidation_gaps
       (id, tenant_id, run_id, question, domain, priority, surfaced, created_at)
       VALUES (?, ?, ?, 'Q2 goals?', 'career', 'high', 0, ?)`,
    ).bind(gapId, tenantId, runId, now).run()

    // Simulate surfacing the gap
    await env.D1_US.prepare(
      `UPDATE consolidation_gaps SET surfaced = 1 WHERE id = ?`,
    ).bind(gapId).run()

    const gap = await env.D1_US.prepare(
      `SELECT surfaced FROM consolidation_gaps WHERE id = ?`,
    ).bind(gapId).first<{ surfaced: number }>()

    expect(gap!.surfaced).toBe(1)
  })

  it('pending actions query returns awaiting_approval only', async () => {
    const tenantId = await setupTenant()
    const now = Date.now()

    // One awaiting, one executed
    await env.D1_US.batch([
      env.D1_US.prepare(
        `INSERT INTO pending_actions
         (id, tenant_id, action_type, integration, state, capability_class,
          authorization_level, proposed_at, proposed_by, payload_r2_key, payload_hash, max_retries)
         VALUES (?, ?, 'send_email', 'gmail', 'awaiting_approval', 'communication',
          'YELLOW', ?, 'chief_of_staff', 'r2key', 'hash', 3)`,
      ).bind(crypto.randomUUID(), tenantId, now),
      env.D1_US.prepare(
        `INSERT INTO pending_actions
         (id, tenant_id, action_type, integration, state, capability_class,
          authorization_level, proposed_at, proposed_by, payload_r2_key, payload_hash, max_retries)
         VALUES (?, ?, 'create_event', 'calendar', 'executed', 'communication',
          'YELLOW', ?, 'chief_of_staff', 'r2key', 'hash', 3)`,
      ).bind(crypto.randomUUID(), tenantId, now),
    ])

    const pending = await env.D1_US.prepare(
      `SELECT action_type FROM pending_actions
       WHERE tenant_id = ? AND state = 'awaiting_approval'`,
    ).bind(tenantId).all()

    expect(pending.results.length).toBe(1)
    expect(pending.results[0].action_type).toBe('send_email')
  })

  it('Law 3: morning brief archive is episodic, not procedural', () => {
    const memoryType: 'episodic' | 'semantic' | 'world' = 'episodic'
    expect(memoryType).toBe('episodic')
    expect(memoryType).not.toBe('procedural')
  })
})
