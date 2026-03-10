import { Hono } from 'hono'
import {
  approvePendingAction,
  clampPositiveInt,
  listTenantActions,
  rejectPendingAction,
} from '../../../services/action/approval-api'
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
    return c.json(await approvePendingAction(
      c.req.param('id'),
      c.get('tenantId'),
      c.get('jwtSub'),
      c.env,
    ))
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
    return c.json(await rejectPendingAction(
      c.req.param('id'),
      c.get('tenantId'),
      c.get('jwtSub'),
      body.reason?.trim() || null,
      c.env,
    ))
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (error.message === 'ACTION_NOT_FOUND') return c.json({ error: 'Action not found' }, 404)
    if (error.message === 'ACTION_NOT_AWAITING_APPROVAL') {
      return c.json({ error: 'Action not awaiting approval' }, 409)
    }
    throw error
  }
})
