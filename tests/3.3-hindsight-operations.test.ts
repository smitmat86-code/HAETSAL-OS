import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { handleHindsightOperationsTick } from '../src/cron/hindsight-operations'

const noopCtx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

function makeHindsightEnv(
  statusByOperationId: Record<string, { status: string; error_message?: string | null }>,
  documentById: Record<string, { memory_unit_count: number } | null> = {},
) {
  return {
    ...env,
    HINDSIGHT: {
      fetch: async (input: RequestInfo | URL) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(input.toString())

        const documentMatch = url.pathname.match(/^\/v1\/default\/banks\/[^/]+\/documents\/([^/]+)$/)
        if (documentMatch) {
          const documentId = decodeURIComponent(documentMatch[1]!)
          const document = documentById[documentId]
          if (document == null) {
            return new Response(JSON.stringify({ detail: 'Not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response(JSON.stringify({
            id: documentId,
            bank_id: 'bank-ops-test',
            original_text: 'Retained source text',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            memory_unit_count: document.memory_unit_count,
            tags: ['tenant:test'],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const match = url.pathname.match(/^\/v1\/default\/banks\/[^/]+\/operations\/([^/]+)$/)
        if (!match) {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const operationId = decodeURIComponent(match[1]!)
        const details = statusByOperationId[operationId] ?? { status: 'pending' }
        return new Response(JSON.stringify({
          operation_id: operationId,
          status: details.status,
          operation_type: 'retain',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: details.status === 'completed' ? new Date().toISOString() : null,
          error_message: details.error_message ?? null,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  } as unknown as typeof env
}

describe('3.3 Hindsight operations polling', () => {
  beforeEach(async () => {
    await env.D1_US.exec('DELETE FROM memory_audit; DELETE FROM ingestion_events; DELETE FROM hindsight_operations; DELETE FROM tenants;')
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT INTO tenants
       (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind('tenant-ops-test', now, now, 'bank-ops-test', now).run()
  })

  it('marks pending operations completed and writes an audit row', async () => {
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT INTO hindsight_operations
       (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
        salience_tier, dedup_hash, stone_r2_key, operation_type, status, error_message, requested_at,
        created_at, updated_at, completed_at, last_checked_at)
       VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
               'pending', NULL, ?, ?, ?, NULL, NULL)`,
    ).bind('op-complete-1', 'tenant-ops-test', 'bank-ops-test', 'doc-complete-1', 'dedup-complete-1', now, now, now).run()

    await handleHindsightOperationsTick(makeHindsightEnv({
      'op-complete-1': { status: 'completed' },
    }), noopCtx)

    const operation = await env.D1_US.prepare(
      `SELECT status, completed_at, last_checked_at, error_message
       FROM hindsight_operations
       WHERE operation_id = ?`,
    ).bind('op-complete-1').first<{
      status: string
      completed_at: number | null
      last_checked_at: number | null
      error_message: string | null
    }>()

    expect(operation?.status).toBe('completed')
    expect(operation?.completed_at).not.toBeNull()
    expect(operation?.last_checked_at).not.toBeNull()
    expect(operation?.error_message).toBeNull()

    const audit = await env.D1_US.prepare(
      `SELECT operation, memory_id FROM memory_audit WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind('tenant-ops-test').first<{ operation: string; memory_id: string | null }>()

    expect(audit?.operation).toBe('memory.retain_completed')
    expect(audit?.memory_id).toBe('doc-complete-1')
  })

  it('marks pending operations available once the source document exists', async () => {
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT INTO hindsight_operations
       (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
        salience_tier, dedup_hash, stone_r2_key, operation_type, status, error_message, requested_at,
        created_at, updated_at, completed_at, last_checked_at)
       VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
               'pending', NULL, ?, ?, ?, NULL, NULL)`,
    ).bind('op-available-1', 'tenant-ops-test', 'bank-ops-test', 'doc-available-1', 'dedup-available-1', now, now, now).run()

    await handleHindsightOperationsTick(makeHindsightEnv(
      { 'op-available-1': { status: 'pending' } },
      { 'doc-available-1': { memory_unit_count: 2 } },
    ), noopCtx)

    const operation = await env.D1_US.prepare(
      `SELECT status, available_at, availability_source, availability_last_checked_at, availability_error_message
       FROM hindsight_operations
       WHERE operation_id = ?`,
    ).bind('op-available-1').first<{
      status: string
      available_at: number | null
      availability_source: string | null
      availability_last_checked_at: number | null
      availability_error_message: string | null
    }>()

    expect(operation?.status).toBe('pending')
    expect(operation?.available_at).not.toBeNull()
    expect(operation?.availability_source).toBe('document')
    expect(operation?.availability_last_checked_at).not.toBeNull()
    expect(operation?.availability_error_message).toBeNull()

    const audit = await env.D1_US.prepare(
      `SELECT operation, memory_id FROM memory_audit WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind('tenant-ops-test').first<{ operation: string; memory_id: string | null }>()

    expect(audit?.operation).toBe('memory.retain_available')
    expect(audit?.memory_id).toBe('doc-available-1')
  })

  it('marks failed operations failed and writes an audit row', async () => {
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT INTO hindsight_operations
       (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
        salience_tier, dedup_hash, stone_r2_key, operation_type, status, error_message, requested_at,
        created_at, updated_at, completed_at, last_checked_at)
       VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
               'pending', NULL, ?, ?, ?, NULL, NULL)`,
    ).bind('op-failed-1', 'tenant-ops-test', 'bank-ops-test', 'doc-failed-1', 'dedup-failed-1', now, now, now).run()

    await handleHindsightOperationsTick(makeHindsightEnv({
      'op-failed-1': { status: 'failed', error_message: 'provider timeout' },
    }), noopCtx)

    const operation = await env.D1_US.prepare(
      `SELECT status, error_message, completed_at, last_checked_at
       FROM hindsight_operations
       WHERE operation_id = ?`,
    ).bind('op-failed-1').first<{
      status: string
      error_message: string | null
      completed_at: number | null
      last_checked_at: number | null
    }>()

    expect(operation?.status).toBe('failed')
    expect(operation?.error_message).toBe('provider timeout')
    expect(operation?.completed_at).not.toBeNull()
    expect(operation?.last_checked_at).not.toBeNull()

    const audit = await env.D1_US.prepare(
      `SELECT operation, memory_id FROM memory_audit WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind('tenant-ops-test').first<{ operation: string; memory_id: string | null }>()

    expect(audit?.operation).toBe('memory.retain_failed')
    expect(audit?.memory_id).toBe('doc-failed-1')
  })

  it('marks aged pending operations as delayed and stuck once', async () => {
    const now = Date.now()
    const stuckRequestedAt = now - (11 * 60 * 1000)
    await env.D1_US.prepare(
      `INSERT INTO hindsight_operations
       (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain, memory_type,
        salience_tier, dedup_hash, stone_r2_key, operation_type, status, error_message, requested_at,
        created_at, updated_at, completed_at, last_checked_at, slow_at, stuck_at)
       VALUES (?, ?, ?, ?, 'mcp_retain', 'test', 'general', 'semantic', 3, ?, 'stone/test', 'retain',
               'pending', NULL, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    ).bind('op-stuck-1', 'tenant-ops-test', 'bank-ops-test', 'doc-stuck-1', 'dedup-stuck-1', stuckRequestedAt, stuckRequestedAt, stuckRequestedAt).run()

    await handleHindsightOperationsTick(makeHindsightEnv({
      'op-stuck-1': { status: 'pending' },
    }), noopCtx)

    const operation = await env.D1_US.prepare(
      `SELECT slow_at, stuck_at FROM hindsight_operations WHERE operation_id = ?`,
    ).bind('op-stuck-1').first<{ slow_at: number | null; stuck_at: number | null }>()

    expect(operation?.slow_at).not.toBeNull()
    expect(operation?.stuck_at).not.toBeNull()

    const auditRows = await env.D1_US.prepare(
      `SELECT operation FROM memory_audit WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 4`,
    ).bind('tenant-ops-test').all<{ operation: string }>()
    const operations = (auditRows.results ?? []).map(row => row.operation)

    expect(operations).toContain('memory.retain_delayed')
    expect(operations).toContain('memory.retain_stuck')
  })
})
