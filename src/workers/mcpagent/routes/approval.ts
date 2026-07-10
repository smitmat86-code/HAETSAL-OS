import { Hono } from 'hono'
import {
  approvePendingAction,
  clampPositiveInt,
  listTenantActions,
  rejectPendingAction,
} from '../../../services/action/approval-api'
import { executeApprovedAction } from '../../../services/action/approved-execution'
import { deriveTmk } from '../../../middleware/auth'
import type { Env } from '../../../types/env'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const approval = new Hono<{ Bindings: Env; Variables: Variables }>()

approval.get('/', async (c) => {
  const stateParam = c.req.query('state') ?? 'awaiting_approval'
  const limit = clampPositiveInt(c.req.query('limit'), 20, 100)
  const offset = clampPositiveInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER)

  try {
    return c.json(await listTenantActions(
      c.get('tenantId'),
      c.get('jwtSub'),
      stateParam,
      limit,
      offset,
      c.env,
    ))
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_STATE_FILTER') {
      return c.json({ error: 'Invalid state filter' }, 400)
    }
    throw error
  }
})

approval.post('/:id/approve', async (c) => {
  try {
    const result = await approvePendingAction(
      c.req.param('id'),
      c.get('tenantId'),
      c.get('jwtSub'),
      c.env,
    )
    // Human approval is the gate. Irreversible work enters the delayed workflow;
    // reversible work can execute immediately with the re-derived tenant key.
    if (result.capability_class === 'WRITE_EXTERNAL_IRREVERSIBLE') {
      const instance = await c.env.ACTION_APPROVAL_WORKFLOW.get(result.action_id)
      await instance.sendEvent({
        type: 'approval-response',
        payload: {
          approved: true,
          jwtSub: c.get('jwtSub'),
          sendDelaySeconds: result.send_delay_seconds,
        },
      })
    } else {
      const tmk = await deriveTmk(c.get('jwtSub'), c.env.CF_ACCESS_AUD)
      c.executionCtx.waitUntil(
        executeApprovedAction(result.action_id, c.get('tenantId'), tmk, c.env, c.executionCtx),
      )
    }
    return c.json(result)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (error.message === 'ACTION_NOT_FOUND') return c.json({ error: 'Action not found' }, 404)
    if (error.message === 'ACTION_NOT_AWAITING_APPROVAL') {
      return c.json({ error: 'Action not awaiting approval' }, 409)
    }
    throw error
  }
})

approval.post('/:id/reject', async (c) => {
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }))
  try {
    const result = await rejectPendingAction(
      c.req.param('id'),
      c.get('tenantId'),
      c.get('jwtSub'),
      body.reason?.trim() || null,
      c.env,
    )
    if (result.capability_class === 'WRITE_EXTERNAL_IRREVERSIBLE') {
      const instance = await c.env.ACTION_APPROVAL_WORKFLOW.get(result.action_id)
      await instance.sendEvent({
        type: 'approval-response',
        payload: { approved: false, jwtSub: c.get('jwtSub'), sendDelaySeconds: 0 },
      }).catch(() => undefined)
    }
    return c.json(result)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (error.message === 'ACTION_NOT_FOUND') return c.json({ error: 'Action not found' }, 404)
    if (error.message === 'ACTION_NOT_AWAITING_APPROVAL') {
      return c.json({ error: 'Action not awaiting approval' }, 409)
    }
    throw error
  }
})
