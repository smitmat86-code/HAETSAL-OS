// tests/1.1-infrastructure.test.ts
// Runs against real Cloudflare Worker bindings via vitest-pool-workers
// D1 migrations applied via apply-migrations.ts setup file
// HINDSIGHT service binding stubbed in vitest.config.ts

import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

describe('1.1 Infrastructure Bedrock', () => {

  it('D1 migrations applied — all tables exist', async () => {
    const tables = await env.D1_US.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all()
    const names = tables.results.map((r: any) => r.name)

    // 1001
    expect(names).toContain('tenants')
    expect(names).toContain('tenant_members')
    // 1002
    expect(names).toContain('memory_audit')
    expect(names).toContain('agent_traces')
    expect(names).toContain('agent_cost_summary')
    expect(names).toContain('ingestion_events')
    expect(names).toContain('cron_executions')
    // 1003
    expect(names).toContain('anomaly_signals')
    expect(names).toContain('graph_health_snapshots')
    expect(names).toContain('mental_model_history')
    expect(names).toContain('predictions')
    // 1004
    expect(names).toContain('pending_actions')
    expect(names).toContain('action_audit')
    expect(names).toContain('tenant_action_preferences')
    expect(names).toContain('scheduled_tasks')
    expect(names).toContain('action_templates')
  })

  it('tenant_id column present on all tenant-scoped tables', async () => {
    const tenantScopedTables = [
      'tenant_members', 'memory_audit', 'agent_traces', 'agent_cost_summary',
      'ingestion_events', 'cron_executions', 'anomaly_signals',
      'graph_health_snapshots', 'mental_model_history', 'predictions',
      'pending_actions', 'action_audit', 'tenant_action_preferences',
      'scheduled_tasks', 'action_templates',
    ]
    for (const table of tenantScopedTables) {
      const cols = await env.D1_US.prepare(
        `PRAGMA table_info(${table})`
      ).all()
      const colNames = cols.results.map((r: any) => r.name)
      expect(colNames, `${table} missing tenant_id`).toContain('tenant_id')
    }
  })

  it('KV_SESSION namespace accessible', async () => {
    await env.KV_SESSION.put('__test__', 'ok', { expirationTtl: 60 })
    const val = await env.KV_SESSION.get('__test__')
    expect(val).toBe('ok')
    await env.KV_SESSION.delete('__test__')
  })

  it('R2_ARTIFACTS bucket accessible', async () => {
    await env.R2_ARTIFACTS.put('__test_artifacts__', 'ok')
    const obj = await env.R2_ARTIFACTS.get('__test_artifacts__')
    expect(obj).not.toBeNull()
    const text = await obj!.text()
    expect(text).toBe('ok')
    await env.R2_ARTIFACTS.delete('__test_artifacts__')
  })

  it('R2_OBSERVABILITY bucket accessible', async () => {
    await env.R2_OBSERVABILITY.put('__test_obs__', 'ok')
    const obj = await env.R2_OBSERVABILITY.get('__test_obs__')
    expect(obj).not.toBeNull()
    const text = await obj!.text()
    expect(text).toBe('ok')
    await env.R2_OBSERVABILITY.delete('__test_obs__')
  })

  it.skip('Hindsight Container health check passes (requires running container)', async () => {
    // Container is DO-backed — requires real deployment to test
    // The HINDSIGHT binding is a DurableObjectNamespace, not a Fetcher
    // Integration test at deploy time validates container connectivity
  })

  it('No content fields in D1 schema — plaintext check', async () => {
    const forbidden = ['content', 'body', 'plaintext', 'raw_text']
    const tables = await env.D1_US.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all()
    for (const tableRow of tables.results as any[]) {
      if (tableRow.name.startsWith('_') || tableRow.name.startsWith('sqlite_')) continue
      const cols = await env.D1_US.prepare(
        `PRAGMA table_info(${tableRow.name})`
      ).all()
      const colNames = cols.results.map((r: any) => r.name)
      for (const f of forbidden) {
        expect(colNames, `${tableRow.name} has forbidden column '${f}'`).not.toContain(f)
      }
    }
  })
})
