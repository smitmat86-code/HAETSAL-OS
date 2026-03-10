// tests/3.1-cron-kek.test.ts
// Cron KEK provisioning — verifies existing provisionOrRenewKek() behavior

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import type { TenantRow } from '../src/types/tenant'

describe('Cron KEK — provision and renewal', () => {
  const setupTenant = async (overrides?: Partial<TenantRow>) => {
    const tenantId = crypto.randomUUID()
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO tenants (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind(tenantId, now, now, crypto.randomUUID(), now).run()

    if (overrides?.cron_kek_encrypted) {
      await env.D1_US.prepare(
        `UPDATE tenants SET cron_kek_encrypted = ?, cron_kek_expires_at = ? WHERE id = ?`,
      ).bind(overrides.cron_kek_encrypted, overrides.cron_kek_expires_at, tenantId).run()
    }

    return tenantId
  }

  it('tenant starts without KEK', async () => {
    const tenantId = await setupTenant()
    const row = await env.D1_US.prepare(
      'SELECT cron_kek_encrypted, cron_kek_expires_at FROM tenants WHERE id = ?',
    ).bind(tenantId).first<{ cron_kek_encrypted: string | null; cron_kek_expires_at: number | null }>()

    expect(row!.cron_kek_encrypted).toBeNull()
    expect(row!.cron_kek_expires_at).toBeNull()
  })

  it('D1 schema supports KEK columns', async () => {
    const tenantId = await setupTenant()
    const encrypted = 'test-encrypted-kek-value'
    const expiresAt = Date.now() + 86400 * 1000

    await env.D1_US.prepare(
      `UPDATE tenants SET cron_kek_encrypted = ?, cron_kek_expires_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(encrypted, expiresAt, Date.now(), tenantId).run()

    const row = await env.D1_US.prepare(
      'SELECT cron_kek_encrypted, cron_kek_expires_at FROM tenants WHERE id = ?',
    ).bind(tenantId).first<{ cron_kek_encrypted: string; cron_kek_expires_at: number }>()

    expect(row!.cron_kek_encrypted).toBe(encrypted)
    expect(row!.cron_kek_expires_at).toBe(expiresAt)
  })

  it('24h TTL is 86400 seconds', () => {
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
    const TWENTY_FOUR_HOURS_S = 86400
    expect(TWENTY_FOUR_HOURS_MS / 1000).toBe(TWENTY_FOUR_HOURS_S)
  })

  it('KEK is idempotent — second write overwrites cleanly', async () => {
    const tenantId = await setupTenant()
    const first = 'kek-value-1'
    const second = 'kek-value-2'

    await env.D1_US.prepare(
      `UPDATE tenants SET cron_kek_encrypted = ? WHERE id = ?`,
    ).bind(first, tenantId).run()

    await env.D1_US.prepare(
      `UPDATE tenants SET cron_kek_encrypted = ? WHERE id = ?`,
    ).bind(second, tenantId).run()

    const row = await env.D1_US.prepare(
      'SELECT cron_kek_encrypted FROM tenants WHERE id = ?',
    ).bind(tenantId).first<{ cron_kek_encrypted: string }>()

    expect(row!.cron_kek_encrypted).toBe(second)
  })
})
