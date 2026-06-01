// src/workers/mcpagent/index.ts — Hono app route registrations
import { getAgentByName } from 'agents'
import { Hono } from 'hono'
import { McpAgentDO } from './do/McpAgent'
import { authMiddleware } from '../../middleware/auth'
import { auditMiddleware } from '../../middleware/audit'
import { dlpMiddleware } from '../../middleware/dlp'
import { ingest } from './routes/ingest'
import { auth } from './routes/auth'
import { actions } from './routes/actions'
import { approval } from './routes/approval'
import { settings } from './routes/settings'
import { audit } from './routes/audit'
import type { Env } from '../../types/env'
import { getMcpAgentObjectName } from './do/identity'
import { registerPublicWebhooks } from './public-webhooks'
import { handleBrainQueue, handleBrainScheduled } from './runtime'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()
const mcpHandler = McpAgentDO.serve('/mcp', { binding: 'MCPAGENT' })

// Security headers — skip on WebSocket 101 (immutable in workerd)
// LESSON: WebSocket 101 headers are immutable — mutating throws TypeError
app.use('*', async (c, next) => {
  const isWebSocket = c.req.header('Upgrade') === 'websocket'
  try {
    await next()
  } finally {
    if (!isWebSocket && c.res) {
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('X-Frame-Options', 'DENY')
      c.header('Referrer-Policy', 'no-referrer')
    }
  }
})

// SMS ingest route — Law 1 exception: NOT behind CF Access
app.route('/ingest', ingest)
registerPublicWebhooks(app)

// Auth on all remaining routes — Law 1: no route bypasses JWT validation
app.use('*', authMiddleware())
app.use('*', auditMiddleware())
app.use('/mcp/*', dlpMiddleware())
app.use('/mcp', dlpMiddleware())

// Auth routes (Google OAuth — Phase 2.2)
app.route('/auth', auth)


// Action routes (undo — Phase 2.3)
app.route('/actions', actions)
app.route('/api/actions', actions)
app.route('/api/actions', approval)
app.route('/api/settings', settings)
app.route('/api/audit', audit)

// MCP Streamable HTTP — delegate to DO
app.all('/mcp', async (c) => {
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')

  try {
    return await mcpHandler.fetch(c.req.raw, c.env, {
      waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx),
      passThroughOnException: c.executionCtx.passThroughOnException.bind(c.executionCtx),
      props: { tenantId, jwtSub },
    } as ExecutionContext<Record<string, unknown>>)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('MCP_ROUTE_FETCH_FAILED', { tenantId, detail })
    return c.json({ error: 'mcp_fetch_failed', detail }, 500)
  }
})

// WebSocket upgrade — delegate to DO
// LESSON: Use new Request(url, c.req.raw) to preserve upgrade semantics
app.get('/ws', async (c) => {
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const namespace = c.env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  const stub = await getAgentByName(namespace, getMcpAgentObjectName(tenantId), {
    props: { tenantId, jwtSub },
  })
  return stub.fetch(new Request(c.req.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  }))
})

export { McpAgentDO }
export { GraphitiContainer } from './do/GraphitiContainer'
export { HindsightContainer, HindsightWorkerContainer } from './do/HindsightContainer'
export { BootstrapWorkflow } from '../../workflows/bootstrap'
export default {
  fetch: app.fetch,
  queue: handleBrainQueue,
  scheduled: handleBrainScheduled,
}
