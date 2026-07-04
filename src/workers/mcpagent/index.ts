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
import { canary } from './routes/canary'
import { agentDashboard, agentRuns } from './routes/agent-runs'
import { automations } from './routes/automations' // Phase 7
import { dream } from './routes/dream' // Phase 8
import type { Env } from '../../types/env'
import { getMcpAgentObjectName } from './do/identity'
import { registerPublicWebhooks } from './public-webhooks'
import { registerPhoneQuery, registerTelegramQuery } from './self-registration'
import { renderMemoryInventory } from './debug-inventory'
import { handleBrainQueue, handleBrainScheduled } from './runtime'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

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
app.route('/_canary', canary)

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
// Phase 6/7: sub-agent runs + live-agent panel + automations (CF Access)
app.route('/api/agents', agentRuns)
app.route('/dashboard/agents', agentDashboard)
app.route('/api/automations', automations)
app.route('/api/dream', dream)

// Read-only diagnostic view over the caller's own canonical memory (no bodies).
app.get('/debug/memory-inventory', renderMemoryInventory)

// Root status page - doubles as a session/KEK refresh: opening it after CF
// Access login initializes the tenant session + provisions the 24h Cron KEK.
app.get('/', async (c) => {
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const namespace = c.env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  const stub = await getAgentByName(namespace, getMcpAgentObjectName(tenantId), {
    props: { tenantId, jwtSub },
  })
  await stub.initTenant(jwtSub, tenantId)

  // Optional one-click phone registration for the messaging channels:
  // /?phone=%2B15551234567 maps the caller's tenant to that E.164 number so
  // inbound iMessage/SMS from it resolves to this tenant. Authenticated via
  // CF Access like everything else on this route.
  const phone = c.req.query('phone')?.trim()
  const phoneNote = phone ? await registerPhoneQuery(c.env, tenantId, phone) : ''
  const tg = c.req.query('telegram_chat_id')?.trim()
  const telegramNote = tg ? await registerTelegramQuery(c.env, tenantId, tg) : ''

  return c.html(`<!doctype html><html><head><title>HAETSAL</title></head>
<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;line-height:1.6">
<h1>HAETSAL brain is running</h1>
<p>Session refreshed for tenant <code>${tenantId.slice(0, 8)}&hellip;</code> —
the cron key is now valid for 24 hours. You can close this tab.</p>
${phoneNote}
${telegramNote}
</body></html>`)
})

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
// Phase 6 facet class — resolved via ctx.exports; export name MUST stay `ExecutionAgent`.
export { ExecutionAgent } from '../../agents/execution-agent'
export { BootstrapWorkflow } from '../../workflows/bootstrap'
export { DreamCycleWorkflow } from '../../workflows/dream-cycle' // Phase 8
export default {
  fetch: app.fetch,
  queue: handleBrainQueue,
  scheduled: handleBrainScheduled,
}
