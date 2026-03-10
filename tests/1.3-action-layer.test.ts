// tests/1.3-action-layer.test.ts
// Action layer integration tests
// Tests run against real D1 via vitest-pool-workers
// LESSON: Each test creates its own data — no cross-test state dependency
// LESSON: Tests import service functions directly (agents SDK bundling issue)

import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { runAuthorizationGate, computePreferenceHmac } from '../src/services/action/authorization'
import { hashPayload, verifyPayloadHash } from '../src/services/action/toctou'
import { processAction } from '../src/workers/action/index'
import type { ActionQueueMessage } from '../src/types/action'

const TEST_TENANT = 'test-tenant-action-layer-0001'
const TEST_HMAC_SECRET = 'test-hmac-secret-not-production'

function buildActionMessage(overrides: Partial<ActionQueueMessage> = {}): ActionQueueMessage {
  const payload_stub = overrides.payload_stub ?? 'test-payload-data'
  return {
    action_id: overrides.action_id ?? crypto.randomUUID(),
    tenant_id: overrides.tenant_id ?? TEST_TENANT,
    proposed_by: overrides.proposed_by ?? 'mcpagent/tool',
    tool_name: overrides.tool_name ?? 'brain_v1_act_search',
    capability_class: overrides.capability_class ?? 'READ',
    integration: overrides.integration ?? 'web',
    payload_r2_key: overrides.payload_r2_key ?? `actions/${TEST_TENANT}/test`,
    payload_hash: overrides.payload_hash ?? '',
    payload_stub,
  }
}

async function buildMessageWithHash(
  overrides: Partial<ActionQueueMessage> = {}
): Promise<ActionQueueMessage> {
  const msg = buildActionMessage(overrides)
  if (!msg.payload_hash) {
    msg.payload_hash = await hashPayload(msg.payload_stub)
  }
  return msg
}

// Helper: Insert a tenant row so FK constraints pass
// Column names verified against migrations/1001_brain_tenants.sql
async function ensureTestTenant(tenantId: string = TEST_TENANT) {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel,
      hindsight_tenant_id, ai_cost_daily_usd, ai_cost_monthly_usd,
      ai_cost_reset_at, ai_ceiling_daily_usd, ai_ceiling_monthly_usd,
      obsidian_sync_enabled)
     VALUES (?, ?, ?, 'us', 'sms', ?, 0, 0, ?, 5.0, 50.0, 0)`
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

// Helper: Insert a preference row with valid HMAC
async function buildValidPreference(
  tenantId: string,
  capabilityClass: string,
  authLevel: string
) {
  const prefId = crypto.randomUUID()
  const now = Date.now()
  const pref = {
    id: prefId, tenant_id: tenantId,
    capability_class: capabilityClass,
    integration: null,
    authorization_level: authLevel,
    send_delay_seconds: 0,
    trust_threshold: 10,
    requires_phrase: null,
    created_at: now,
  }
  const hmac = await computePreferenceHmac(pref as never, TEST_HMAC_SECRET)
  await env.D1_US.prepare(
    `INSERT INTO tenant_action_preferences
     (id, tenant_id, capability_class, integration, authorization_level,
      send_delay_seconds, confirmed_executions, trust_threshold, row_hmac, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 0, 0, 10, ?, ?, ?)`
  ).bind(prefId, tenantId, capabilityClass, authLevel, hmac, now, now).run()
}

describe('1.3 Action Layer', () => {

  describe('Authorization Gate', () => {
    it('READ capability class routes GREEN with no preference row', async () => {
      const result = await runAuthorizationGate(TEST_TENANT, 'READ', 'gmail', env)
      expect(result.effectiveLevel).toBe('GREEN')
      expect(result.hmacValid).toBe(true)
      expect(result.preferenceFound).toBe(false)
    })

    it('WRITE_EXTERNAL_FINANCIAL routes RED (hard floor)', async () => {
      const result = await runAuthorizationGate(
        TEST_TENANT, 'WRITE_EXTERNAL_FINANCIAL', 'stripe', env
      )
      expect(result.effectiveLevel).toBe('RED')
    })

    it('HMAC failure → effective level RED', async () => {
      const tenantId = 'tenant-hmac-fail-test'
      await ensureTestTenant(tenantId)
      await env.D1_US.prepare(
        `INSERT INTO tenant_action_preferences
         (id, tenant_id, capability_class, integration, authorization_level,
          send_delay_seconds, confirmed_executions, trust_threshold, row_hmac, created_at, updated_at)
         VALUES (?, ?, 'WRITE_EXTERNAL_REVERSIBLE', NULL, 'GREEN', 0, 0, 10, 'invalid_hmac', ?, ?)`
      ).bind(crypto.randomUUID(), tenantId, Date.now(), Date.now()).run()

      const result = await runAuthorizationGate(
        tenantId, 'WRITE_EXTERNAL_REVERSIBLE', 'calendar', env
      )
      expect(result.effectiveLevel).toBe('RED')
      expect(result.hmacValid).toBe(false)
      expect(result.preferenceFound).toBe(true)
    })

    it('tenant preference cannot lower below hard floor', async () => {
      const tenantId = 'tenant-floor-test'
      await ensureTestTenant(tenantId)
      // Try GREEN for WRITE_EXTERNAL_REVERSIBLE (hard floor is YELLOW)
      await buildValidPreference(tenantId, 'WRITE_EXTERNAL_REVERSIBLE', 'GREEN')
      const result = await runAuthorizationGate(
        tenantId, 'WRITE_EXTERNAL_REVERSIBLE', 'calendar', env
      )
      expect(result.effectiveLevel).toBe('YELLOW')  // Floor enforced
    })
  })

  describe('TOCTOU', () => {
    it('matching hash verifies correctly', async () => {
      const payload = 'test action payload'
      const hash = await hashPayload(payload)
      expect(await verifyPayloadHash(payload, hash)).toBe(true)
    })

    it('tampered payload fails verification', async () => {
      const hash = await hashPayload('original payload')
      expect(await verifyPayloadHash('tampered payload', hash)).toBe(false)
    })
  })

  describe('Queue Consumer', () => {
    it('GREEN action executes and writes completed state', async () => {
      await ensureTestTenant()
      const msg = await buildMessageWithHash({
        capability_class: 'READ', tool_name: 'brain_v1_act_search',
      })
      await processAction(msg, env)

      const row = await env.D1_US.prepare(
        'SELECT state FROM pending_actions WHERE id = ?'
      ).bind(msg.action_id).first<{ state: string }>()
      expect(row!.state).toBe('completed')

      const audit = await env.D1_US.prepare(
        `SELECT event FROM action_audit WHERE action_id = ? AND event = 'action.executed_stub'`
      ).bind(msg.action_id).first()
      expect(audit).not.toBeNull()
    })

    it('YELLOW action stays awaiting_approval', async () => {
      await ensureTestTenant()
      const msg = await buildMessageWithHash({
        capability_class: 'WRITE_EXTERNAL_IRREVERSIBLE',
        tool_name: 'brain_v1_act_send_message',
      })
      await processAction(msg, env)

      const row = await env.D1_US.prepare(
        'SELECT state, authorization_level FROM pending_actions WHERE id = ?'
      ).bind(msg.action_id).first<{ state: string; authorization_level: string }>()
      expect(row!.state).toBe('awaiting_approval')
      expect(row!.authorization_level).toBe('YELLOW')
    })

    it('RED action is rejected — no execution', async () => {
      await ensureTestTenant()
      const msg = await buildMessageWithHash({
        capability_class: 'WRITE_EXTERNAL_FINANCIAL',
        tool_name: 'brain_v1_act_send_message',
      })
      await processAction(msg, env)

      const row = await env.D1_US.prepare(
        'SELECT state FROM pending_actions WHERE id = ?'
      ).bind(msg.action_id).first<{ state: string }>()
      expect(row!.state).toBe('rejected')

      const executed = await env.D1_US.prepare(
        `SELECT id FROM action_audit WHERE action_id = ? AND event = 'action.executed_stub'`
      ).bind(msg.action_id).first()
      expect(executed).toBeNull()
    })

    it('TOCTOU mismatch aborts and writes anomaly signal', async () => {
      await ensureTestTenant()
      const msg = await buildMessageWithHash({
        capability_class: 'READ',
        payload_stub: 'original',
        payload_hash: await hashPayload('tampered'),
      })
      await processAction(msg, env)

      const anomaly = await env.D1_US.prepare(
        `SELECT signal_type FROM anomaly_signals WHERE related_id = ?`
      ).bind(msg.action_id).first<{ signal_type: string }>()
      expect(anomaly!.signal_type).toBe('toctou_violation')

      const row = await env.D1_US.prepare(
        'SELECT state FROM pending_actions WHERE id = ?'
      ).bind(msg.action_id).first<{ state: string }>()
      expect(row!.state).toBe('failed')
    })

    it('INSERT OR IGNORE — redelivered message is no-op', async () => {
      await ensureTestTenant()
      const msg = await buildMessageWithHash({ capability_class: 'READ' })
      await processAction(msg, env)
      await processAction(msg, env)  // Redeliver

      const count = await env.D1_US.prepare(
        'SELECT COUNT(*) as c FROM pending_actions WHERE id = ?'
      ).bind(msg.action_id).first<{ c: number }>()
      expect(count!.c).toBe(1)
    })

    it('D1 never contains plaintext payload content', async () => {
      await ensureTestTenant()
      const sensitiveContent = 'SENSITIVE_CONTENT_NEVER_IN_D1'
      const msg = await buildMessageWithHash({
        capability_class: 'READ',
        payload_stub: sensitiveContent,
      })
      await processAction(msg, env)

      const row = await env.D1_US.prepare(
        'SELECT * FROM pending_actions WHERE id = ?'
      ).bind(msg.action_id).first()
      const rowJson = JSON.stringify(row)
      expect(rowJson).not.toContain(sensitiveContent)
    })
  })
})
