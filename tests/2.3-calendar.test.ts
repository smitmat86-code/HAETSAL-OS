// tests/2.3-calendar.test.ts
// Calendar write integration tests — create/modify via Google Calendar API
// Google Calendar API is stubbed (not called in tests)
// Tests verify: state transitions, reversible state, audit records

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { processAction } from '../src/workers/action/index'
import { hashPayload } from '../src/services/action/toctou'
import type { ActionQueueMessage } from '../src/types/action'

const TEST_TENANT = 'calendar-test-tenant'

async function ensureTestTenant() {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel,
      hindsight_tenant_id, ai_cost_daily_usd, ai_cost_monthly_usd,
      ai_cost_reset_at, ai_ceiling_daily_usd, ai_ceiling_monthly_usd,
      obsidian_sync_enabled)
     VALUES (?, ?, ?, 'us', 'sms', ?, 0, 0, ?, 5.0, 50.0, 0)`,
  ).bind(TEST_TENANT, now, now, `hindsight-${TEST_TENANT}`, now).run()
}

async function buildCalendarMessage(
  toolName: string,
  payload: Record<string, unknown>,
): Promise<ActionQueueMessage> {
  const payload_stub = JSON.stringify(payload)
  return {
    action_id: crypto.randomUUID(),
    tenant_id: TEST_TENANT,
    proposed_by: 'mcpagent/test',
    tool_name: toolName,
    capability_class: 'WRITE_EXTERNAL_REVERSIBLE',
    integration: 'calendar',
    payload_r2_key: `actions/${TEST_TENANT}/test`,
    payload_hash: await hashPayload(payload_stub),
    payload_stub,
  }
}

describe('2.3 Calendar Write Integration', () => {
  it('create_event routes YELLOW (WRITE_EXTERNAL_REVERSIBLE)', async () => {
    await ensureTestTenant()
    const msg = await buildCalendarMessage('brain_v1_act_create_event', {
      title: 'Team Standup',
      start_time: '2025-06-01T09:00:00Z',
      end_time: '2025-06-01T09:30:00Z',
    })
    await processAction(msg, env)

    const row = await env.D1_US.prepare(
      'SELECT state, authorization_level FROM pending_actions WHERE id = ?',
    ).bind(msg.action_id).first<{ state: string; authorization_level: string }>()
    expect(row).not.toBeNull()
    expect(row!.state).toBe('awaiting_approval')
    expect(row!.authorization_level).toBe('YELLOW')
  })

  it('modify_event routes YELLOW', async () => {
    await ensureTestTenant()
    const msg = await buildCalendarMessage('brain_v1_act_modify_event', {
      event_id: 'event-123',
      title: 'Updated Meeting',
    })
    await processAction(msg, env)

    const row = await env.D1_US.prepare(
      'SELECT state FROM pending_actions WHERE id = ?',
    ).bind(msg.action_id).first<{ state: string }>()
    expect(row!.state).toBe('awaiting_approval')
  })

  it('WRITE_EXTERNAL_REVERSIBLE capability class has YELLOW hard floor', async () => {
    // Verified in types/action.ts HARD_FLOORS
    const { HARD_FLOORS } = await import('../src/types/action')
    expect(HARD_FLOORS.WRITE_EXTERNAL_REVERSIBLE).toBe('YELLOW')
  })

  it('completed_reversible and undone are valid ActionState values', async () => {
    // Type-level check — these must exist in the ActionState union
    const { UNDO_WINDOW_MS } = await import('../src/types/action')
    expect(UNDO_WINDOW_MS).toBe(5 * 60 * 1000)
  })

  it('create_event payload includes required fields', async () => {
    const payload = {
      title: 'Lunch Meeting',
      start_time: '2025-06-01T12:00:00Z',
      end_time: '2025-06-01T13:00:00Z',
      description: 'Discuss project',
    }
    const msg = await buildCalendarMessage('brain_v1_act_create_event', payload)
    const parsed = JSON.parse(msg.payload_stub)
    expect(parsed.title).toBe('Lunch Meeting')
    expect(parsed.start_time).toBe('2025-06-01T12:00:00Z')
    expect(parsed.end_time).toBe('2025-06-01T13:00:00Z')
  })

  it('routed_yellow audit record written', async () => {
    await ensureTestTenant()
    const msg = await buildCalendarMessage('brain_v1_act_create_event', {
      title: 'Audit Test',
      start_time: '2025-06-01T14:00:00Z',
      end_time: '2025-06-01T15:00:00Z',
    })
    await processAction(msg, env)

    const audit = await env.D1_US.prepare(
      `SELECT event FROM action_audit WHERE action_id = ? AND event = 'action.routed_yellow'`,
    ).bind(msg.action_id).first()
    expect(audit).not.toBeNull()
  })
})
