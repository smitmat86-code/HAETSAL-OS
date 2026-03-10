// src/workers/action/index.ts
// Action Worker — queue consumer only, no HTTP surface
// LESSON: INSERT OR IGNORE for all queue consumer INSERTs (at-least-once safety)
// LESSON: Promise.allSettled for fan-out (not sequential for...of)

import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'
import { runAuthorizationGate } from '../../services/action/authorization'
import { verifyPayloadHash } from '../../services/action/toctou'
import { broadcastEvent } from '../../services/action/executor'
import { routeGreen, routeYellow, routeRed, writeAnomalyAndAudit } from '../../services/action/router'

// Exported for use by main worker entry's queue() handler
export async function handleActionBatch(
  batch: MessageBatch<ActionQueueMessage>, env: Env
): Promise<void> {
  // LESSON: Promise.allSettled for concurrent fan-out
  const results = await Promise.allSettled(
    batch.messages.map(msg => processAction(msg.body, env, msg))
  )
  const failures = results.filter(r => r.status === 'rejected')
  if (failures.length > 0 && failures.length === batch.messages.length) {
    throw new Error(`All ${failures.length} action messages failed`)
  }
}

// Exported for direct testing — tests call this, not the full Worker
export async function processAction(
  msg: ActionQueueMessage,
  env: Env,
  rawMsg?: Message<ActionQueueMessage>
): Promise<void> {
  const db = env.D1_US
  const now = Date.now()

  // LESSON: INSERT OR IGNORE — redelivered message is a no-op, not a crash
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO pending_actions
     (id, tenant_id, proposed_at, proposed_by, capability_class, integration,
      action_type, state, authorization_level, send_delay_seconds,
      payload_r2_key, payload_hash, retry_count, max_retries)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'YELLOW', 0, ?, ?, 0, 3)`
  ).bind(
    msg.action_id, msg.tenant_id, now, msg.proposed_by,
    msg.capability_class, msg.integration, msg.tool_name,
    msg.payload_r2_key, msg.payload_hash
  ).run()

  if (inserted.meta.changes === 0) { rawMsg?.ack(); return }

  // Write proposal audit record
  await db.prepare(
    `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
     VALUES (?, ?, ?, ?, 'action.proposed', ?)`
  ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by).run()

  // Authorization gate
  const auth = await runAuthorizationGate(
    msg.tenant_id, msg.capability_class, msg.integration, env
  )

  if (!auth.hmacValid) {
    await writeAnomalyAndAudit(db, msg, 'action.hmac_invalid', now)
    await broadcastEvent(env, msg.tenant_id, {
      type: 'action.blocked', action_id: msg.action_id,
      tool_name: msg.tool_name, capability_class: msg.capability_class,
      tenant_id: msg.tenant_id, reason: 'hmac_invalid'
    })
    rawMsg?.ack(); return
  }

  // TOCTOU verification
  if (!(await verifyPayloadHash(msg.payload_stub, msg.payload_hash))) {
    await writeAnomalyAndAudit(db, msg, 'action.toctou_violation', now)
    await broadcastEvent(env, msg.tenant_id, {
      type: 'action.toctou_violation', action_id: msg.action_id,
      tenant_id: msg.tenant_id
    })
    rawMsg?.ack(); return
  }

  // Route by effective authorization level
  switch (auth.effectiveLevel) {
    case 'GREEN':  await routeGreen(msg, auth.sendDelaySeconds, env, now); break
    case 'YELLOW': await routeYellow(msg, auth.sendDelaySeconds, env, now); break
    case 'RED':    await routeRed(msg, env, now); break
  }

  rawMsg?.ack()
}
