// src/workers/mcpagent/routes/actions.ts
// Action routes — POST /actions/:id/undo
// Behind CF Access auth (inherited from middleware in index.ts)

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import type { PendingActionRow } from '../../../types/action'
import { UNDO_WINDOW_MS } from '../../../types/action'
import { executeDeleteEvent } from '../../../services/action/integrations/calendar'
import { broadcastEvent } from '../../../services/action/executor'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const actions = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * POST /:id/undo — undo a reversible action within the 5-minute window
 * Only valid for completed_reversible actions
 * Calendar create → delete the event
 */
actions.post('/:id/undo', async (c) => {
  const actionId = c.req.param('id')
  const tenantId = c.get('tenantId')
  const now = Date.now()

  const row = await c.env.D1_US.prepare(
    `SELECT * FROM pending_actions WHERE id = ? AND tenant_id = ?`,
  ).bind(actionId, tenantId).first<PendingActionRow>()

  if (!row) return c.json({ error: 'Action not found' }, 404)

  if (row.state !== 'completed_reversible') {
    return c.json({ error: 'Action is not in a reversible state' }, 400)
  }

  // Check 5-minute window
  const executedAt = row.executed_at ?? 0
  if (now - executedAt > UNDO_WINDOW_MS) {
    return c.json({ error: 'Undo window expired' }, 409)
  }

  // Get TMK for integration calls
  let tmk: CryptoKey | null = null
  try {
    const doId = c.env.MCPAGENT.idFromName(tenantId)
    const stub = c.env.MCPAGENT.get(doId)
    // @ts-expect-error -- DO RPC method not in generic DurableObjectStub type
    tmk = await stub.getTmk()
  } catch { /* tmk stays null */ }

  if (!tmk) return c.json({ error: 'TMK unavailable — cannot undo' }, 503)

  // Execute integration-specific undo
  const resultSummary = row.result_summary ?? ''
  if (resultSummary.startsWith('created_event:')) {
    const eventId = resultSummary.replace('created_event:', '')
    await executeDeleteEvent(eventId, tenantId, tmk, c.env)
  }
  // modify_event undo: not supported in Phase 2.3 (would need snapshot)

  // Atomic state transition + audit
  const db = c.env.D1_US
  await db.batch([
    db.prepare(
      `UPDATE pending_actions SET state = 'undone' WHERE id = ?`,
    ).bind(actionId),
    db.prepare(
      `INSERT INTO action_audit (id, tenant_id, action_id, created_at, event, agent_identity)
       VALUES (?, ?, ?, ?, 'action.undone', ?)`,
    ).bind(crypto.randomUUID(), tenantId, actionId, now, c.get('jwtSub')),
  ])

  await broadcastEvent(c.env, tenantId, {
    type: 'action.undone', action_id: actionId, tenant_id: tenantId,
  })

  return c.json({ status: 'undone', action_id: actionId })
})
