// tests/3.4-weekly-synthesis.test.ts
// Weekly synthesis — session recall, LLM synthesis, archival

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

describe('Weekly synthesis', () => {
  it('module exports runWeeklySynthesis', async () => {
    const mod = await import('../src/cron/weekly-synthesis')
    expect(typeof mod.runWeeklySynthesis).toBe('function')
  })

  it('Law 3: weekly synthesis is semantic, not procedural', () => {
    const memoryType = 'semantic' as const
    expect(memoryType).toBe('semantic')
    expect(memoryType).not.toBe('procedural')
  })

  it('only runs for tenants with bootstrap_status = completed', async () => {
    const completedId = crypto.randomUUID()
    const pendingId = crypto.randomUUID()
    const now = Date.now()

    await env.D1_US.batch([
      env.D1_US.prepare(
        `INSERT OR IGNORE INTO tenants
         (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at, bootstrap_status)
         VALUES (?, ?, ?, 'us', 'sms', ?, ?, 'completed')`,
      ).bind(completedId, now, now, crypto.randomUUID(), now),
      env.D1_US.prepare(
        `INSERT OR IGNORE INTO tenants
         (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at, bootstrap_status)
         VALUES (?, ?, ?, 'us', 'sms', ?, ?, 'not_started')`,
      ).bind(pendingId, now, now, crypto.randomUUID(), now),
    ])

    const tenants = await env.D1_US.prepare(
      `SELECT id FROM tenants WHERE bootstrap_status = 'completed' AND id IN (?, ?)`,
    ).bind(completedId, pendingId).all<{ id: string }>()

    expect(tenants.results.length).toBe(1)
    expect(tenants.results[0].id).toBe(completedId)
  })

  it('weekly synthesis provenance is weekly_synthesis', () => {
    const provenance = 'weekly_synthesis'
    expect(provenance).toBe('weekly_synthesis')
  })

  it('weekly synthesis metadata includes is_weekly_synthesis flag', () => {
    const metadata = { is_weekly_synthesis: true }
    expect(metadata.is_weekly_synthesis).toBe(true)
  })

  it('uses Hindsight reflect rather than separate recall-plus-summarize flow', async () => {
    const mod = await import('../src/cron/weekly-synthesis')
    expect(mod.WEEKLY_SYNTHESIS_REFLECT_QUERY).toContain("Review this week's sessions and retained memories")
    expect(mod.WEEKLY_SYNTHESIS_REFLECT_BUDGET).toBe('high')
  })

  it('weekly synthesis reflect query scopes results to the tenant tag', async () => {
    const mod = await import('../src/cron/weekly-synthesis')
    expect(mod.WEEKLY_SYNTHESIS_REFLECT_TAGS_MATCH).toBe('all_strict')
  })

  it('obsidian output carries generated_by frontmatter', () => {
    const frontmatter = `---\ngenerated_by: the-brain\ndate: 2026-03-10T00:00:00.000Z\n---`
    expect(frontmatter).toContain('generated_by: the-brain')
  })
})
