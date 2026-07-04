// src/services/action/approved-execution.ts
// Runs an IRREVERSIBLE action after a human approves it. The proposal step
// persists the action payload TMK-encrypted in R2 (the queue message that
// carried the plaintext stub is long gone by approval time). Here we decrypt
// it with the tenant TMK and run the normal executor path.
//
// Known limitation (documented, Phase 13): approval executes immediately —
// the send-delay "cancel window" for irreversible actions is not yet a durable
// timer. The human approval IS the gate; the delay-to-cancel is a future add.

import type { Env } from '../../types/env'
import type { ActionQueueMessage, CapabilityClass } from '../../types/action'
import { decryptWithKek, fetchAndValidateKek } from '../../cron/kek'
import { executeAction } from './executor'

interface ApprovedActionRow {
  id: string
  tool_name: string
  capability_class: CapabilityClass
  integration: string
  payload_r2_key: string
  payload_hash: string
  proposed_by: string
  state: string
}

export async function executeApprovedAction(
  actionId: string,
  tenantId: string,
  tmk: CryptoKey,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const row = await env.D1_US.prepare(
    `SELECT id, action_type AS tool_name, capability_class, integration,
            payload_r2_key, payload_hash, proposed_by, state
     FROM pending_actions WHERE id = ? AND tenant_id = ?`,
  ).bind(actionId, tenantId).first<ApprovedActionRow>()
  if (!row || row.state !== 'queued') return

  const stored = await env.R2_ARTIFACTS.get(row.payload_r2_key)
  if (!stored) throw new Error('approved action payload missing from R2')
  // Family-tagged blobs (Phase 13): TMK1 = session key, KEK1 = cron fallback,
  // untagged = pre-Phase-13 TMK blobs. The families are NOT interchangeable.
  const blob = await stored.text()
  let payload_stub: string
  if (blob.startsWith('KEK1:')) {
    const kek = await fetchAndValidateKek(tenantId, env)
    if (!kek) throw new Error('approved action payload is KEK-sealed and the Cron KEK is unavailable — authenticate once to refresh it')
    payload_stub = await decryptWithKek(blob.slice(5), kek)
  } else {
    payload_stub = await decryptWithKek(blob.startsWith('TMK1:') ? blob.slice(5) : blob, tmk)
  }

  const msg: ActionQueueMessage = {
    action_id: row.id, tenant_id: tenantId, proposed_by: row.proposed_by,
    tool_name: row.tool_name, capability_class: row.capability_class,
    integration: row.integration, payload_r2_key: row.payload_r2_key,
    payload_hash: row.payload_hash, payload_stub,
  }
  await executeAction(msg, tmk, env, ctx, Date.now())
}
