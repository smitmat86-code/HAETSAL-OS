// src/workers/mcpagent/routes/automations.ts
// Phase 7 automations API (behind CF Access auth middleware, like /api/agents).
// The dashboard automations panel (Phase 11) consumes this; the live-smoke
// gate drives it directly.

import { Hono } from 'hono'
import { getAgentByName } from 'agents'
import type { Env } from '../../../types/env'
import type { McpAgentDO } from '../do/McpAgent'
import { getMcpAgentObjectName } from '../do/identity'
import type { RecurrenceKind } from '../../../services/automations/recurrence'
import { DEFAULT_TZ } from '../../../services/automations/recurrence'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

async function stubFor(env: Env, tenantId: string, jwtSub: string) {
  const namespace = env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  return getAgentByName(namespace, getMcpAgentObjectName(tenantId), { props: { tenantId, jwtSub } })
}

const KINDS = new Set<RecurrenceKind>(['daily', 'weekdays', 'weekly'])

export const automations = new Hono<{ Bindings: Env; Variables: Variables }>()

automations.get('/', async (c) => {
  const stub = await stubFor(c.env, c.get('tenantId'), c.get('jwtSub'))
  return c.json(await stub.listAutomationsRpc())
})

automations.post('/', async (c) => {
  type CreateBody = { task?: string; kind?: string; hour?: number; minute?: number; dayOfWeek?: number; tz?: string }
  const body = await c.req.json<CreateBody>().catch(() => ({} as CreateBody))
  const task = body.task?.trim()
  const kind = body.kind as RecurrenceKind | undefined
  if (!task || task.length > 1000 || !kind || !KINDS.has(kind)
    || typeof body.hour !== 'number' || body.hour < 0 || body.hour > 23) {
    return c.json({ error: 'task, kind (daily|weekdays|weekly), and hour (0-23) required' }, 400)
  }
  const tenantId = c.get('tenantId')
  const chat = await c.env.D1_US.prepare(
    'SELECT chat_id FROM telegram_chats WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1',
  ).bind(tenantId).first<{ chat_id: number }>().catch(() => null)
  const stub = await stubFor(c.env, tenantId, c.get('jwtSub'))
  try {
    const result = await stub.createAutomationRpc({
      task,
      spec: {
        kind, hour: body.hour, minute: body.minute ?? 0,
        ...(kind === 'weekly' ? { dayOfWeek: body.dayOfWeek ?? 1 } : {}),
        tz: body.tz ?? DEFAULT_TZ,
      },
      replyChannel: 'telegram',
      replyTo: chat ? String(chat.chat_id) : '',
    })
    return c.json(result, 201)
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 409)
  }
})

automations.post('/:id/toggle', async (c) => {
  const enabled = c.req.query('enabled') !== 'false'
  const stub = await stubFor(c.env, c.get('tenantId'), c.get('jwtSub'))
  try {
    return c.json(await stub.toggleAutomationRpc(c.req.param('id'), enabled))
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 404)
  }
})

automations.delete('/:id', async (c) => {
  const stub = await stubFor(c.env, c.get('tenantId'), c.get('jwtSub'))
  try {
    return c.json(await stub.deleteAutomationRpc(c.req.param('id')))
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 404)
  }
})
