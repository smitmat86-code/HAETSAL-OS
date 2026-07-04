// src/workers/mcpagent/routes/agent-runs.ts
// Phase 6 dashboard surface: run listing + cancel + retry, all behind the CF
// Access auth middleware chain (registered after authMiddleware in index.ts).
// Route handlers stay thin — the DO owns the ledger and the actions.

import { Hono } from 'hono'
import { getAgentByName } from 'agents'
import type { Env } from '../../../types/env'
import type { McpAgentDO } from '../do/McpAgent'
import { getMcpAgentObjectName } from '../do/identity'
import { AGENT_DASHBOARD_HTML } from '../dashboard-agents-html'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

async function tenantStub(env: Env, tenantId: string, jwtSub: string) {
  const namespace = env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  return getAgentByName(namespace, getMcpAgentObjectName(tenantId), {
    props: { tenantId, jwtSub },
  })
}

export const agentRuns = new Hono<{ Bindings: Env; Variables: Variables }>()

agentRuns.get('/runs', async (c) => {
  const stub = await tenantStub(c.env, c.get('tenantId'), c.get('jwtSub'))
  const limitRaw = Number(c.req.query('limit') ?? '20')
  const runs = await stub.listAgentRuns(Number.isFinite(limitRaw) ? limitRaw : 20)
  return c.json(runs)
})

const PROFILES = new Set(['research', 'memory', 'comms', 'general'])

// Dashboard-initiated run (also the self-driven live-smoke entry). Results
// deliver to the tenant's registered Telegram chat when one exists; without
// one the run still executes and the ledger carries the encrypted result.
agentRuns.post('/runs', async (c) => {
  const tenantId = c.get('tenantId')
  const body = await c.req.json<{ task?: string; profile?: string }>().catch(() => ({} as { task?: string; profile?: string }))
  const task = body.task?.trim()
  if (!task || task.length > 2000) return c.json({ error: 'task required (1-2000 chars)' }, 400)
  const profile = PROFILES.has(body.profile ?? '') ? body.profile! : 'research'
  const chat = await c.env.D1_US.prepare(
    'SELECT chat_id FROM telegram_chats WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1',
  ).bind(tenantId).first<{ chat_id: number }>().catch(() => null)
  const stub = await tenantStub(c.env, tenantId, c.get('jwtSub'))
  try {
    const result = await stub.dispatchExecutionTask({
      task, profile: profile as 'research',
      replyChannel: 'telegram', replyTo: chat ? String(chat.chat_id) : '',
    })
    return c.json(result, 201)
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 409)
  }
})

agentRuns.post('/runs/:runId/cancel', async (c) => {
  const stub = await tenantStub(c.env, c.get('tenantId'), c.get('jwtSub'))
  const result = await stub.cancelAgentRun(c.req.param('runId'))
  return c.json(result)
})

agentRuns.post('/runs/:runId/retry', async (c) => {
  const stub = await tenantStub(c.env, c.get('tenantId'), c.get('jwtSub'))
  try {
    const result = await stub.retryAgentRun(c.req.param('runId'))
    return c.json(result)
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 409)
  }
})

export const agentDashboard = new Hono<{ Bindings: Env; Variables: Variables }>()

agentDashboard.get('/', async (c) => {
  // Touching the DO here refreshes the tenant session (TMK + KEK) exactly like
  // the root status page, so dispatch/retry work right after CF Access login.
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const stub = await tenantStub(c.env, tenantId, jwtSub)
  await stub.initTenant(jwtSub, tenantId)
  return c.html(AGENT_DASHBOARD_HTML)
})
