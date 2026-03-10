// src/services/action/executor.ts
// Stub execution — marks action completed, writes audit, broadcasts
// Real integrations (Gmail, Calendar, SMS) wired in Phase 2.x

import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'

export async function executeStub(
  msg: ActionQueueMessage, env: Env, now: number
): Promise<void> {
  const db = env.D1_US
  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'completed', executed_at = ?,
       result_summary = 'stub_executed'
       WHERE id = ?`
    ).bind(now, msg.action_id),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.executed_stub', ?)`
    ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by),
  ])

  // TODO: Phase 2.1 — write episodic memory to Hindsight on successful execution
  // episodic_memory_id = await hindsightClient.retain({ type: 'action_executed', ... })
  // Then UPDATE pending_actions SET episodic_memory_id = ? WHERE id = ?

  await broadcastEvent(env, msg.tenant_id, {
    type: 'action.executed', action_id: msg.action_id,
    tool_name: msg.tool_name, tenant_id: msg.tenant_id
  })
}

export async function broadcastEvent(
  env: Env, tenantId: string, payload: unknown
): Promise<void> {
  try {
    const id = env.MCPAGENT.idFromName(tenantId)
    const stub = env.MCPAGENT.get(id) as DurableObjectStub<never>
    // @ts-expect-error — DO RPC method (confirmed 1.2 pattern)
    await stub.broadcast(payload)
  } catch {
    // Non-fatal — WebSocket push is best-effort; Pages UI polls as fallback
  }
}
