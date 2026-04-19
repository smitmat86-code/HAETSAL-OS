// tests/1.2-auth.test.ts
// Auth + tenant bootstrap integration tests
// Tests JWT validation, tenant creation, and KEK provisioning.

import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { deriveTenantId, deriveTmk } from '../src/middleware/auth'
import { deriveAccessPrincipalId } from '../src/middleware/cf-access'
import { getOrCreateTenant, provisionOrRenewKek } from '../src/services/tenant'
import { getMcpAgentObjectName } from '../src/workers/mcpagent/do/identity'
import { installCfAccessMock } from './support/cf-access'

const TEST_AUD = 'test-aud-brain-access'
const TEST_SUB = 'test-user-sub-12345'

describe('1.2 Auth - Tenant ID Derivation', () => {
  it('deriveTenantId produces deterministic hex string', async () => {
    const id1 = await deriveTenantId(TEST_SUB, TEST_AUD)
    const id2 = await deriveTenantId(TEST_SUB, TEST_AUD)
    expect(id1).toBe(id2)
    expect(id1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different sub produces different tenant_id', async () => {
    const id1 = await deriveTenantId(TEST_SUB, TEST_AUD)
    const id2 = await deriveTenantId('different-sub', TEST_AUD)
    expect(id1).not.toBe(id2)
  })

  it('tenant_id is never the raw JWT sub', async () => {
    const id = await deriveTenantId(TEST_SUB, TEST_AUD)
    expect(id).not.toBe(TEST_SUB)
    expect(id).not.toContain(TEST_SUB)
  })

  it('derives a stable service principal id from app tokens', () => {
    expect(deriveAccessPrincipalId({
      sub: '',
      type: 'app',
      common_name: 'haetsal-brain-shell-smoke',
    })).toBe('service:haetsal-brain-shell-smoke')
  })
})

describe('1.2 Auth - TMK Derivation', () => {
  it('deriveTmk produces non-extractable AES-GCM key', async () => {
    const tmk = await deriveTmk(TEST_SUB, TEST_AUD)
    expect(tmk.type).toBe('secret')
    expect(tmk.extractable).toBe(false)
    expect(tmk.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(tmk.usages).toContain('encrypt')
    expect(tmk.usages).toContain('decrypt')
  })

  it('same sub produces same TMK behavior', async () => {
    const tmk1 = await deriveTmk(TEST_SUB, TEST_AUD)
    const tmk2 = await deriveTmk(TEST_SUB, TEST_AUD)
    const plaintext = new TextEncoder().encode('test-data')
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct1 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tmk1, plaintext)
    const pt2 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, tmk2, ct1)
    expect(new Uint8Array(pt2)).toEqual(plaintext)
  })
})

describe('1.2 Auth - Tenant Bootstrap', () => {
  it('maps tenant ids to streamable-http MCP agent ids', async () => {
    const tenantId = await deriveTenantId('mcp-agent-id-sub', TEST_AUD)
    const objectName = getMcpAgentObjectName(tenantId)

    expect(objectName).toBe(`streamable-http:${tenantId}`)
  })

  it('creates tenant with 4 scheduled_tasks atomically', async () => {
    const tenantId = await deriveTenantId(TEST_SUB, TEST_AUD)
    const result = await getOrCreateTenant(tenantId, TEST_SUB, env)
    expect(result.isNew).toBe(true)
    expect(result.tenant.id).toBe(tenantId)
    expect(result.tenant.hindsight_tenant_id).toBeTruthy()
    expect(result.tenant.hindsight_tenant_id).not.toBe(tenantId)

    const tasks = await env.D1_US.prepare(
      'SELECT * FROM scheduled_tasks WHERE tenant_id = ?',
    ).bind(tenantId).all()
    expect(tasks.results.length).toBe(4)
    const taskNames = tasks.results.map((task: Record<string, unknown>) => task.task_name)
    expect(taskNames).toContain('consolidation_cron')
    expect(taskNames).toContain('morning_brief')
    expect(taskNames).toContain('gap_discovery')
    expect(taskNames).toContain('weekly_synthesis')
  })

  it('second auth is idempotent and does not duplicate', async () => {
    const tenantId = await deriveTenantId('idempotent-test-sub', TEST_AUD)
    await getOrCreateTenant(tenantId, 'idempotent-test-sub', env)
    const result2 = await getOrCreateTenant(tenantId, 'idempotent-test-sub', env)
    expect(result2.isNew).toBe(false)

    const tenants = await env.D1_US.prepare(
      'SELECT COUNT(*) as count FROM tenants WHERE id = ?',
    ).bind(tenantId).first<{ count: number }>()
    expect(tenants!.count).toBe(1)
  })

  it('different tenants get different persisted hindsight bank ids', async () => {
    const tenantA = await deriveTenantId('bank-a-sub', TEST_AUD)
    const tenantB = await deriveTenantId('bank-b-sub', TEST_AUD)
    const resultA = await getOrCreateTenant(tenantA, 'bank-a-sub', env)
    const resultB = await getOrCreateTenant(tenantB, 'bank-b-sub', env)

    expect(resultA.tenant.hindsight_tenant_id).toBeTruthy()
    expect(resultB.tenant.hindsight_tenant_id).toBeTruthy()
    expect(resultA.tenant.hindsight_tenant_id).not.toBe(resultB.tenant.hindsight_tenant_id)
  })

  it('provisions KEK and ciphertext differs from plaintext', async () => {
    const tenantId = await deriveTenantId('kek-test-sub', TEST_AUD)
    const { tenant } = await getOrCreateTenant(tenantId, 'kek-test-sub', env)
    const tmk = await deriveTmk('kek-test-sub', TEST_AUD)
    await provisionOrRenewKek(tenant, tmk, env)

    const updated = await env.D1_US.prepare(
      'SELECT cron_kek_encrypted, cron_kek_expires_at FROM tenants WHERE id = ?',
    ).bind(tenantId).first<{ cron_kek_encrypted: string; cron_kek_expires_at: number }>()

    expect(updated!.cron_kek_encrypted).toBeTruthy()
    expect(updated!.cron_kek_encrypted.length).toBeGreaterThan(10)
    expect(updated!.cron_kek_expires_at).toBeGreaterThan(Date.now())
  })

  it('writes audit record on tenant creation', async () => {
    const tenantId = await deriveTenantId('audit-test-sub', TEST_AUD)
    await getOrCreateTenant(tenantId, 'audit-test-sub', env)

    const audit = await env.D1_US.prepare(
      'SELECT * FROM memory_audit WHERE tenant_id = ? AND operation = ?',
    ).bind(tenantId, 'auth.tenant_created').first()

    expect(audit).toBeTruthy()
  })
})

describe('1.2 Auth - Service Principal Routing', () => {
  it('maps Cloudflare Access service tokens to a dedicated hashed tenant', async () => {
    const auth = await installCfAccessMock({
      sub: '',
      type: 'app',
      common_name: 'haetsal-brain-shell-smoke',
    })

    try {
      const response = await SELF.fetch('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'CF-Access-Jwt-Assertion': auth.jwt,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      expect(response.status).toBe(200)
      const body = await response.json() as { status: string; tenantId: string }
      expect(body.status).toBe('mcp_ok')
      expect(body.tenantId).toBe(
        await deriveTenantId('service:haetsal-brain-shell-smoke', TEST_AUD),
      )
    } finally {
      auth.restore()
    }
  })
})
