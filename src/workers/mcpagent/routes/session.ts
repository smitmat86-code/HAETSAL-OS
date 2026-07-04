// src/workers/mcpagent/routes/session.ts
// Phase 9 working-session surface (CF Access): read a channel session window
// (transient decrypt on the DO) and force-close one into an evidence summary.
// Consumed by the Phase 11 dashboard and the gate smoke.

import { Hono } from 'hono'
import { getAgentByName } from 'agents'
import type { Env } from '../../../types/env'
import type { McpAgentDO } from '../do/McpAgent'
import { getMcpAgentObjectName } from '../do/identity'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

async function stubFor(env: Env, tenantId: string, jwtSub: string) {
  const namespace = env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  return getAgentByName(namespace, getMcpAgentObjectName(tenantId), { props: { tenantId, jwtSub } })
}

export const session = new Hono<{ Bindings: Env; Variables: Variables }>()

session.get('/:key/window', async (c) => {
  const stub = await stubFor(c.env, c.get('tenantId'), c.get('jwtSub'))
  const block = await stub.getSessionWindowBlock(c.req.param('key'))
  return c.json({ sessionKey: c.req.param('key'), window: block })
})

session.post('/:key/close', async (c) => {
  const stub = await stubFor(c.env, c.get('tenantId'), c.get('jwtSub'))
  return c.json(await stub.closeSessionRpc(c.req.param('key')))
})
