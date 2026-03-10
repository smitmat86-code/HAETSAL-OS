import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { deriveTenantId } from '../src/middleware/auth'
import { installCfAccessMock } from './support/cf-access'

const TEST_AUD = 'test-aud-brain-access'

async function ensureTestTenant(sub: string): Promise<{ sub: string; tenantId: string }> {
  const tenantId = await deriveTenantId(sub, TEST_AUD)
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel,
      hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()

  return { sub, tenantId }
}

async function insertAction(
  tenantId: string,
  state: string,
  sendDelaySeconds = 120,
): Promise<string> {
  const actionId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO pending_actions
     (id, tenant_id, proposed_at, proposed_by, capability_class, integration,
      action_type, state, authorization_level, send_delay_seconds, execute_after,
      payload_r2_key, payload_hash, retry_count, max_retries, executed_at, result_summary)
     VALUES (?, ?, ?, 'chief_of_staff', 'WRITE_EXTERNAL_IRREVERSIBLE', 'sms',
      'brain_v1_act_send_message', ?, 'YELLOW', ?, NULL,
      ?, ?, 0, 3, ?, ?)`,
  ).bind(
    actionId,
    tenantId,
    now,
    state,
    sendDelaySeconds,
    `actions/${tenantId}/${actionId}`,
    `hash-${actionId}`,
    state === 'completed_reversible' ? now : null,
    state === 'completed_reversible' ? 'created_event:evt-1' : null,
  ).run()

  return actionId
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

describe('1.4 Approval Queue Routes', () => {
  it('lists awaiting approval and reversible actions for the authenticated tenant', async () => {
    const primary = await ensureTestTenant(`phase14-list-${crypto.randomUUID()}`)
    const other = await ensureTestTenant(`phase14-other-${crypto.randomUUID()}`)
    await insertAction(primary.tenantId, 'awaiting_approval')
    await insertAction(primary.tenantId, 'completed_reversible', 0)
    await insertAction(other.tenantId, 'awaiting_approval')

    const response = await authorizedFetch(
      primary.sub,
      '/api/actions?state=awaiting_approval,completed_reversible',
    )

    expect(response.status).toBe(200)
    const data = await response.json() as {
      actions: { state: string }[]
      total: number
    }
    expect(data.total).toBe(2)
    expect(data.actions.map(action => action.state).sort()).toEqual([
      'awaiting_approval',
      'completed_reversible',
    ])
  })

  it('approves an awaiting action and records actor metadata', async () => {
    const ctx = await ensureTestTenant(`phase14-approve-${crypto.randomUUID()}`)
    const actionId = await insertAction(ctx.tenantId, 'awaiting_approval')

    const response = await authorizedFetch(ctx.sub, `/api/actions/${actionId}/approve`, {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { state: string; execute_after: number }
    expect(body.state).toBe('queued')
    expect(body.execute_after).toBeGreaterThan(Date.now())

    const row = await env.D1_US.prepare(
      `SELECT state, approved_by, approved_at
       FROM pending_actions
       WHERE id = ?`,
    ).bind(actionId).first<{ state: string; approved_by: string; approved_at: number }>()
    expect(row).toMatchObject({ state: 'queued', approved_by: ctx.sub })
    expect(row!.approved_at).toBeGreaterThan(0)
  })

  it('rejects an awaiting action and stores the optional reason', async () => {
    const ctx = await ensureTestTenant(`phase14-reject-${crypto.randomUUID()}`)
    const actionId = await insertAction(ctx.tenantId, 'awaiting_approval')

    const response = await authorizedFetch(ctx.sub, `/api/actions/${actionId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Needs manual review' }),
    })

    expect(response.status).toBe(200)
    const row = await env.D1_US.prepare(
      `SELECT state, cancel_reason FROM pending_actions WHERE id = ?`,
    ).bind(actionId).first<{ state: string; cancel_reason: string }>()
    expect(row).toEqual({ state: 'rejected', cancel_reason: 'Needs manual review' })
  })

  it('returns 409 when approving a non-pending action', async () => {
    const ctx = await ensureTestTenant(`phase14-conflict-${crypto.randomUUID()}`)
    const actionId = await insertAction(ctx.tenantId, 'rejected')

    const response = await authorizedFetch(ctx.sub, `/api/actions/${actionId}/approve`, {
      method: 'POST',
    })

    expect(response.status).toBe(409)
  })

  it('returns 404 when the authenticated tenant does not own the action', async () => {
    const owner = await ensureTestTenant(`phase14-owner-${crypto.randomUUID()}`)
    const actor = await ensureTestTenant(`phase14-actor-${crypto.randomUUID()}`)
    const actionId = await insertAction(owner.tenantId, 'awaiting_approval')

    const response = await authorizedFetch(actor.sub, `/api/actions/${actionId}/reject`, {
      method: 'POST',
    })

    expect(response.status).toBe(404)
  })
})
