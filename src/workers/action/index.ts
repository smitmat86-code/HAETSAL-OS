// src/workers/action/index.ts
// Action Worker — queue consumer only, no HTTP surface
// LESSON: INSERT OR IGNORE for all queue consumer INSERTs (at-least-once safety)
// LESSON: Promise.allSettled for fan-out (not sequential for...of)

import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'
import { runAuthorizationGate } from '../../services/action/authorization'
import { verifyPayloadHash } from '../../services/action/toctou'
import { encryptWithKek, fetchAndValidateKek } from '../../cron/kek'
import { getMcpAgentObjectName } from '../mcpagent/do/identity'
import { broadcastEvent } from '../../services/action/executor'
import { routeGreen, routeYellow, routeRed, writeAnomalyAndAudit } from '../../services/action/router'

/** No-op execution context for tests where ctx is not available */
const noopCtx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as ExecutionContext

export async function handleActionBatch(
  batch: MessageBatch<ActionQueueMessage>, env: Env, ctx?: ExecutionContext,
): Promise<void> {
  const ec = ctx ?? noopCtx
  const results = await Promise.allSettled(
    batch.messages.map(msg => processAction(msg.body, env, ec, msg)),
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
  ctx?: ExecutionContext,
  rawMsg?: Message<ActionQueueMessage>,
): Promise<void> {
  const ec = ctx ?? noopCtx
  const db = env.D1_US
  const now = Date.now()

  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO pending_actions
     (id, tenant_id, proposed_at, proposed_by, capability_class, integration,
      action_type, state, authorization_level, send_delay_seconds,
      payload_r2_key, payload_hash, retry_count, max_retries)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'YELLOW', 0, ?, ?, 0, 3)`,
  ).bind(
    msg.action_id, msg.tenant_id, now, msg.proposed_by,
    msg.capability_class, msg.integration, msg.tool_name,
    msg.payload_r2_key, msg.payload_hash,
  ).run()

  if (inserted.meta.changes === 0) { rawMsg?.ack(); return }

  await db.prepare(
    `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
     VALUES (?, ?, ?, ?, 'action.proposed', ?)`,
  ).bind(crypto.randomUUID(), msg.tenant_id, msg.action_id, now, msg.proposed_by).run()

  const auth = await runAuthorizationGate(
    msg.tenant_id, msg.capability_class, msg.integration, env,
  )

  if (!auth.hmacValid) {
    await writeAnomalyAndAudit(db, msg, 'action.hmac_invalid', now)
    await broadcastEvent(env, msg.tenant_id, {
      type: 'action.blocked', action_id: msg.action_id,
      tool_name: msg.tool_name, capability_class: msg.capability_class,
      tenant_id: msg.tenant_id, reason: 'hmac_invalid',
    })
    rawMsg?.ack(); return
  }

  if (!(await verifyPayloadHash(msg.payload_stub, msg.payload_hash))) {
    await writeAnomalyAndAudit(db, msg, 'action.toctou_violation', now)
    await broadcastEvent(env, msg.tenant_id, {
      type: 'action.toctou_violation', action_id: msg.action_id,
      tenant_id: msg.tenant_id,
    })
    rawMsg?.ack(); return
  }

  // Get TMK for execution (needed by calendar integrations + episodic memory)
  // TMK may be null in tests or when DO is cold — stub tools don't need it
  let tmk: CryptoKey | null = null
  try {
    // Phase 13 fix: the session DO is named getMcpAgentObjectName(tenant) —
    // idFromName(raw tenant id) resolved a DIFFERENT, TMK-less DO, so this
    // lookup could never succeed and YELLOW payloads were silently dropped
    // on cold sessions (the Phase 5 verifier gap, root-caused).
    const doId = env.MCPAGENT.idFromName(getMcpAgentObjectName(msg.tenant_id))
    const stub = env.MCPAGENT.get(doId)
    tmk = await stub.getTmk()
  } catch { /* tmk stays null */ }

  // YELLOW actions are deferred to human approval; the queue message (and its
  // plaintext payload_stub) is gone by then, so persist the payload encrypted
  // in R2 for executeApprovedAction. Key FAMILIES are not interchangeable
  // (KEK != TMK, proven at the Phase 8 gate), so the blob is tagged with the
  // family that sealed it: TMK when the session DO is warm, Cron KEK as the
  // cold fallback. If neither key is available the proposal still queues and
  // approval fails honestly (payload missing).
  if (auth.effectiveLevel === 'YELLOW') {
    if (tmk) {
      await env.R2_ARTIFACTS.put(msg.payload_r2_key, 'TMK1:' + await encryptWithKek(msg.payload_stub, tmk))
    } else {
      const kek = await fetchAndValidateKek(msg.tenant_id, env)
      if (kek) await env.R2_ARTIFACTS.put(msg.payload_r2_key, 'KEK1:' + await encryptWithKek(msg.payload_stub, kek))
    }
  }

  if (auth.effectiveLevel === 'YELLOW'
    && msg.capability_class === 'WRITE_EXTERNAL_IRREVERSIBLE') {
    await env.ACTION_APPROVAL_WORKFLOW.create({
      id: msg.action_id,
      params: { actionId: msg.action_id, tenantId: msg.tenant_id },
    })
  }

  switch (auth.effectiveLevel) {
    case 'GREEN':
      await routeGreen(msg, auth.sendDelaySeconds, env, now, tmk, ec)
      break
    case 'YELLOW': await routeYellow(msg, auth.sendDelaySeconds, env, now); break
    case 'RED':    await routeRed(msg, env, now); break
  }

  rawMsg?.ack()
}
