import type { ActionState, PendingActionRow } from '../../types/action'
import type { Env } from '../../types/env'
import { getOrCreateTenant } from '../tenant'
import { broadcastEvent } from './executor'

const ACTION_STATE_FILTERS = new Set<ActionState>([
  'pending', 'queued', 'awaiting_approval', 'completed', 'completed_reversible',
  'undone', 'failed', 'rejected', 'cancelled', 'expired',
])

export async function listTenantActions(tenantId: string, jwtSub: string, stateParam: string, limit: number, offset: number, env: Env) {
  await getOrCreateTenant(tenantId, jwtSub, env)

  const states = parseStates(stateParam)
  if (!states) throw new Error('INVALID_STATE_FILTER')
  const statesJson = JSON.stringify(states)

  const rows = await env.D1_US.prepare(
    `SELECT id, proposed_at, proposed_by, action_type AS tool_name, capability_class,
            integration, action_type, state, authorization_level, send_delay_seconds,
            execute_after, approved_by, approved_at, executed_at, cancel_reason,
            result_summary, episodic_memory_id
     FROM pending_actions
     WHERE tenant_id = ?
       AND (? = 'all' OR state IN (SELECT value FROM json_each(?)))
     ORDER BY proposed_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(tenantId, stateParam, statesJson, limit, offset).all()

  const totalRow = await env.D1_US.prepare(
    `SELECT COUNT(*) AS total
     FROM pending_actions
     WHERE tenant_id = ?
       AND (? = 'all' OR state IN (SELECT value FROM json_each(?)))`,
  ).bind(tenantId, stateParam, statesJson).first<{ total: number }>()

  return { actions: rows.results, limit, offset, total: totalRow?.total ?? 0 }
}

export async function approvePendingAction(actionId: string, tenantId: string, jwtSub: string, env: Env) {
  await getOrCreateTenant(tenantId, jwtSub, env)
  const action = await loadPendingAction(actionId, tenantId, env)
  if (!action) throw new Error('ACTION_NOT_FOUND')
  if (action.state !== 'awaiting_approval') throw new Error('ACTION_NOT_AWAITING_APPROVAL')

  const now = Date.now()
  const executeAfter = now + (action.send_delay_seconds * 1000)
  await env.D1_US.batch([
    env.D1_US.prepare(
      `UPDATE pending_actions
       SET state = 'queued', approved_by = ?, approved_at = ?, execute_after = ?
       WHERE id = ? AND tenant_id = ?`,
    ).bind(jwtSub, now, executeAfter, action.id, tenantId),
    env.D1_US.prepare(
      `INSERT INTO action_audit
       (id, tenant_id, action_id, created_at, event, agent_identity, payload_hash)
       VALUES (?, ?, ?, ?, 'action.approved', ?, ?)`,
    ).bind(crypto.randomUUID(), tenantId, action.id, now, jwtSub, action.payload_hash),
  ])

  await broadcastEvent(env, tenantId, {
    type: 'action.approved',
    action_id: action.id,
    tenant_id: tenantId,
    execute_after: executeAfter,
  })

  return { action_id: action.id, state: 'queued', execute_after: executeAfter }
}

export async function rejectPendingAction(actionId: string, tenantId: string, jwtSub: string, reason: string | null, env: Env) {
  await getOrCreateTenant(tenantId, jwtSub, env)
  const action = await loadPendingAction(actionId, tenantId, env)
  if (!action) throw new Error('ACTION_NOT_FOUND')
  if (action.state !== 'awaiting_approval') throw new Error('ACTION_NOT_AWAITING_APPROVAL')

  const now = Date.now()
  await env.D1_US.batch([
    env.D1_US.prepare(
      `UPDATE pending_actions
       SET state = 'rejected', cancelled_at = ?, cancel_reason = ?
       WHERE id = ? AND tenant_id = ?`,
    ).bind(now, reason, action.id, tenantId),
    env.D1_US.prepare(
      `INSERT INTO action_audit
       (id, tenant_id, action_id, created_at, event, agent_identity, payload_hash, detail_json)
       VALUES (?, ?, ?, ?, 'action.rejected', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      tenantId,
      action.id,
      now,
      jwtSub,
      action.payload_hash,
      reason ? JSON.stringify({ reason }) : null,
    ),
  ])

  await broadcastEvent(env, tenantId, {
    type: 'action.rejected',
    action_id: action.id,
    tenant_id: tenantId,
  })

  return { action_id: action.id, state: 'rejected' }
}

export function clampPositiveInt(rawValue: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10)
  if (Number.isNaN(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

function parseStates(stateParam: string): ActionState[] | 'all' | null {
  if (stateParam === 'all') return 'all'
  const states = stateParam.split(',').map(value => value.trim()).filter(Boolean)
  if (states.length === 0) return null
  return states.every(state => ACTION_STATE_FILTERS.has(state as ActionState))
    ? states as ActionState[]
    : null
}

async function loadPendingAction(actionId: string, tenantId: string, env: Env): Promise<
  Pick<PendingActionRow, 'id' | 'state' | 'send_delay_seconds' | 'payload_hash'> | null
> {
  return env.D1_US.prepare(
    `SELECT id, state, send_delay_seconds, payload_hash
     FROM pending_actions
     WHERE id = ? AND tenant_id = ?`,
  ).bind(actionId, tenantId).first()
}
