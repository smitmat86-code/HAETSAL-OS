// src/services/action/executor.ts
// Real execution: dispatch by tool_name (tool-dispatch.ts) then write the
// atomic state/audit batch, episodic memory, and WS broadcast.
// LESSON: db.batch() for atomic state UPDATE + audit INSERT

import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'
import { UNDO_WINDOW_MS } from '../../types/action'
import { dispatchTool } from './tool-dispatch'
import { writeActionEpisodicMemory } from './integrations/episodic'
import { getMcpAgentObjectId } from '../../workers/mcpagent/do/identity'

/**
 * Execute a real action — dispatches by tool_name, then records state + audit +
 * episodic memory. Tools with no real executor fall through to executeStub.
 */
export async function executeAction(
  msg: ActionQueueMessage, tmk: CryptoKey | null, env: Env, ctx: ExecutionContext, now: number,
): Promise<void> {
  const isReversible = msg.capability_class === 'WRITE_EXTERNAL_REVERSIBLE'

  const dispatched = await dispatchTool(msg, tmk, env, ctx)
  if (dispatched === 'stub') {
    await executeStub(msg, env, now)
    return
  }
  const { resultSummary, externalId, htmlLink } = dispatched

  const newState = isReversible ? 'completed_reversible' : 'completed'
  const db = env.D1_US
  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = ?, executed_at = ?,
       result_summary = ? WHERE id = ?`,
    ).bind(newState, now, resultSummary, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.executed', ?)`,
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by),
  ])

  // Episodic memory — non-blocking via waitUntil (skip if no TMK)
  if (tmk) {
    ctx.waitUntil(writeActionEpisodicMemory(msg, externalId, htmlLink, tmk, env))
  }

  // WebSocket push — include undo_expires_at for reversible actions
  const wsPayload: Record<string, unknown> = {
    type: 'action.executed', action_id: msg.action_id,
    tool_name: msg.tool_name, tenant_id: msg.tenant_id, state: newState,
  }
  if (isReversible) wsPayload.undo_expires_at = now + UNDO_WINDOW_MS
  await broadcastEvent(env, msg.tenant_id, wsPayload)
}

/** Stub execution for tools not yet wired to real integrations */
async function executeStub(
  msg: ActionQueueMessage, env: Env, now: number,
): Promise<void> {
  const db = env.D1_US
  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'completed', executed_at = ?,
       result_summary = 'stub_executed' WHERE id = ?`,
    ).bind(now, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.executed_stub', ?)`,
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by),
  ])
  await broadcastEvent(env, msg.tenant_id, {
    type: 'action.executed', action_id: msg.action_id,
    tool_name: msg.tool_name, tenant_id: msg.tenant_id,
  })
}

export async function broadcastEvent(
  env: Env, tenantId: string, payload: unknown,
): Promise<void> {
  try {
    const id = getMcpAgentObjectId(env.MCPAGENT, tenantId)
    const stub = env.MCPAGENT.get(id) as DurableObjectStub<never>
    // @ts-expect-error — DO RPC method (confirmed 1.2 pattern)
    await stub.broadcast(payload)
  } catch {
    // Non-fatal — WebSocket push is best-effort
  }
}
