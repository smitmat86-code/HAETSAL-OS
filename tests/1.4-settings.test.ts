import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { deriveTenantId } from '../src/middleware/auth'
import { computePreferenceHmac } from '../src/services/action/authorization'
import { installCfAccessMock } from './support/cf-access'

const TEST_AUD = 'test-aud-brain-access'
const HMAC_SECRET = 'test-hmac-secret-not-production'

async function ensureTestTenant(sub: string): Promise<{ sub: string; tenantId: string }> {
  const tenantId = await deriveTenantId(sub, TEST_AUD)
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, primary_email,
      hindsight_tenant_id, ai_cost_daily_usd, ai_cost_monthly_usd,
      ai_cost_reset_at, ai_ceiling_daily_usd, ai_ceiling_monthly_usd)
     VALUES (?, ?, ?, 'us', 'sms', 'matt@example.com', ?, 0.42, 8.13, ?, 5.0, 50.0)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()

  return { sub, tenantId }
}

async function insertPreference(tenantId: string, level: 'GREEN' | 'YELLOW' | 'RED') {
  const now = Date.now()
  const row = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    capability_class: 'WRITE_EXTERNAL_REVERSIBLE' as const,
    integration: null,
    authorization_level: level,
    send_delay_seconds: 0,
    trust_threshold: 10,
    requires_phrase: null,
    created_at: now,
  }
  const hmac = await computePreferenceHmac(row, HMAC_SECRET)
  await env.D1_US.prepare(
    `INSERT INTO tenant_action_preferences
     (id, tenant_id, capability_class, integration, authorization_level,
      send_delay_seconds, confirmed_executions, trust_threshold, requires_phrase,
      row_hmac, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 0, 0, 10, NULL, ?, ?, ?)`,
  ).bind(row.id, tenantId, row.capability_class, level, hmac, now, now).run()
}

async function authorizedFetch(sub: string, path: string, init?: RequestInit): Promise<Response> {
  const auth = await installCfAccessMock(sub)
  try {
    return await SELF.fetch(`http://localhost${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        'CF-Access-Jwt-Assertion': auth.jwt,
      },
    })
  } finally {
    auth.restore()
  }
}

describe('1.4 Settings Routes', () => {
  it('returns tenant settings and all capability preferences', async () => {
    const ctx = await ensureTestTenant(`phase14-settings-${crypto.randomUUID()}`)
    await insertPreference(ctx.tenantId, 'RED')

    const response = await authorizedFetch(ctx.sub, '/api/settings')

    expect(response.status).toBe(200)
    const body = await response.json() as {
      tenant: { primary_email: string; ai_cost_daily_usd: number }
      preferences: { capability_class: string; authorization_level: string }[]
    }
    expect(body.tenant.primary_email).toBe('matt@example.com')
    expect(body.tenant.ai_cost_daily_usd).toBe(0.42)
    expect(body.preferences).toHaveLength(6)
  })

  it('raises a preference to RED and stores a server-side HMAC', async () => {
    const ctx = await ensureTestTenant(`phase14-update-${crypto.randomUUID()}`)

    const response = await authorizedFetch(ctx.sub, '/api/settings/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability_class: 'WRITE_EXTERNAL_REVERSIBLE',
        authorization_level: 'RED',
      }),
    })

    expect(response.status).toBe(200)
    const row = await env.D1_US.prepare(
      `SELECT authorization_level, row_hmac
       FROM tenant_action_preferences
       WHERE tenant_id = ? AND capability_class = 'WRITE_EXTERNAL_REVERSIBLE'`,
    ).bind(ctx.tenantId).first<{ authorization_level: string; row_hmac: string }>()
    expect(row).toMatchObject({ authorization_level: 'RED' })
    expect(row!.row_hmac.length).toBeGreaterThan(20)
  })

  it('rejects writes below the hard floor', async () => {
    const ctx = await ensureTestTenant(`phase14-floor-${crypto.randomUUID()}`)

    const response = await authorizedFetch(ctx.sub, '/api/settings/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability_class: 'WRITE_EXTERNAL_REVERSIBLE',
        authorization_level: 'GREEN',
      }),
    })

    expect(response.status).toBe(409)
  })

  it('does not allow one tenant to overwrite another tenant preference row', async () => {
    const owner = await ensureTestTenant(`phase14-owner-${crypto.randomUUID()}`)
    const actor = await ensureTestTenant(`phase14-actor-${crypto.randomUUID()}`)
    await insertPreference(owner.tenantId, 'RED')

    await authorizedFetch(actor.sub, '/api/settings/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability_class: 'WRITE_EXTERNAL_REVERSIBLE',
        authorization_level: 'YELLOW',
      }),
    })

    const ownerRow = await env.D1_US.prepare(
      `SELECT authorization_level
       FROM tenant_action_preferences
       WHERE tenant_id = ? AND capability_class = 'WRITE_EXTERNAL_REVERSIBLE'`,
    ).bind(owner.tenantId).first<{ authorization_level: string }>()
    expect(ownerRow).toEqual({ authorization_level: 'RED' })
  })
})
