// src/services/action/router.ts
// Action routing: GREEN/YELLOW/RED state transitions + audit
// Extracted from action worker to stay within 150-line limit

import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'
import { executeStub, broadcastEvent } from './executor'

export async function routeGreen(
  msg: ActionQueueMessage, sendDelay: number, env: Env, now: number
) {
  const db = env.D1_US
  const executeAfter = sendDelay > 0 ? now + sendDelay * 1000 : null

  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'queued', authorization_level = 'GREEN',
       send_delay_seconds = ?, execute_after = ?, approved_by = 'auto_green', approved_at = ?
       WHERE id = ?`
    ).bind(sendDelay, executeAfter, now, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.routed_green', ?)`
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by),
  ])

  if (executeAfter) {
    // TODO: Phase 2.x — replace with Workflow step.sleep() for durable send delay
    // For now: mark as queued with execute_after timestamp; Phase 1.4 Cron polls
    await db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.send_delay_started', ?)`
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by).run()
    return  // Don't execute yet — Phase 1.4 picks up queued actions with execute_after
  }

  // Execute immediately (stub)
  await executeStub(msg, env, now)
}

export async function routeYellow(
  msg: ActionQueueMessage, sendDelay: number, env: Env, now: number
) {
  const db = env.D1_US
  const executeAfter = sendDelay > 0 ? now + sendDelay * 1000 : null

  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'awaiting_approval',
       authorization_level = 'YELLOW', send_delay_seconds = ?, execute_after = ?
       WHERE id = ?`
    ).bind(sendDelay, executeAfter, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.routed_yellow', ?)`
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by),
  ])

  await broadcastEvent(env, msg.tenant_id, {
    type: 'action.pending_approval', action_id: msg.action_id,
    tool_name: msg.tool_name, capability_class: msg.capability_class,
    tenant_id: msg.tenant_id
  })
}

export async function routeRed(msg: ActionQueueMessage, env: Env, now: number) {
  const db = env.D1_US
  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'rejected', authorization_level = 'RED',
       cancelled_at = ?, cancel_reason = 'hard_floor_red'
       WHERE id = ?`
    ).bind(now, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.routed_red', ?)`
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by),
  ])

  await broadcastEvent(env, msg.tenant_id, {
    type: 'action.blocked', action_id: msg.action_id,
    tool_name: msg.tool_name, capability_class: msg.capability_class,
    tenant_id: msg.tenant_id
  })
}

export async function writeAnomalyAndAudit(
  db: D1Database, msg: ActionQueueMessage, event: string, now: number
) {
  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'failed', cancelled_at = ?, cancel_reason = ?
       WHERE id = ?`
    ).bind(now, event, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, event, msg.proposed_by),
    db.prepare(
      `INSERT INTO anomaly_signals (id, tenant_id, created_at, signal_type, severity, related_id, detail_json)
       VALUES (?, ?, ?, ?, 'high', ?, ?)`
    ).bind(
      crypto.randomUUID(), msg.tenant_id, now,
      event === 'action.toctou_violation' ? 'toctou_violation' : 'authz_downgrade_attempt',
      msg.action_id,
      JSON.stringify({ action_id: msg.action_id, tool_name: msg.tool_name })
    ),
  ])
}
