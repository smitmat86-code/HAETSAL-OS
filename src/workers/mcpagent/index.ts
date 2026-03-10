// src/workers/mcpagent/index.ts
// Hono app — route registrations only
// LESSON: Security headers in try/finally — skip on WebSocket 101 responses
// LESSON: Queue consumers export queue() alongside fetch() — no separate Worker needed

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
import { handleActionBatch } from '../action/index'
import { handleIngestionBatch } from '../ingestion/consumer'
import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'
import type { IngestionQueueMessage } from '../../types/ingestion'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

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
// Telnyx webhook must reach this endpoint directly
// Mounted BEFORE auth middleware so it bypasses JWT validation
app.route('/ingest', ingest)

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
  const id = c.env.MCPAGENT.idFromName(tenantId)
  const stub = c.env.MCPAGENT.get(id)
  // @ts-expect-error -- DO RPC method not in generic DurableObjectStub type
  await stub.initTenant(jwtSub, tenantId)
  return stub.fetch(c.req.raw)
})

// WebSocket upgrade — delegate to DO
// LESSON: Use new Request(url, c.req.raw) to preserve upgrade semantics
app.get('/ws', async (c) => {
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const id = c.env.MCPAGENT.idFromName(tenantId)
  const stub = c.env.MCPAGENT.get(id)
  // @ts-expect-error -- DO RPC method not in generic DurableObjectStub type
  await stub.initTenant(jwtSub, tenantId)
  // @ts-expect-error -- handleWebSocket is a DO RPC method
  return stub.handleWebSocket(new Request(c.req.url, c.req.raw))
})

export { McpAgentDO }
export { BootstrapWorkflow } from '../../workflows/bootstrap'
export default {
  fetch: app.fetch,
  // LESSON: Queue consumers don't require a separate Worker — export alongside fetch
  async queue(
    batch: MessageBatch<ActionQueueMessage | IngestionQueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Dispatch by queue name — actions vs ingestion
    const queueName = batch.queue
    if (queueName === 'brain-actions') {
      await handleActionBatch(batch as MessageBatch<ActionQueueMessage>, env, ctx)
    } else {
      // QUEUE_HIGH, QUEUE_NORMAL, QUEUE_BULK → ingestion consumer
      await handleIngestionBatch(
        batch as MessageBatch<IngestionQueueMessage>, env, ctx,
      )
    }
  },
  // Obsidian cron polling (Phase 2.2)
  // */1: /to-brain/ folder check, */15: vault-wide brain:true scan
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Get all tenants with Obsidian sync enabled
    const tenants = await env.D1_US.prepare(
      `SELECT id FROM tenants WHERE obsidian_sync_enabled = 1`,
    ).all<{ id: string }>()

    if (!tenants.results?.length) return

    for (const tenant of tenants.results) {
      const lastPollKey = `obsidian_last_poll:${tenant.id}`
      const lastPoll = await env.KV_SESSION.get(lastPollKey)
      const lastPollMs = lastPoll ? parseInt(lastPoll, 10) : 0

      // Skip if polled within the last 55 seconds (1-min cron safety)
      if (event.cron === '*/1 * * * *' && Date.now() - lastPollMs < 55_000) continue

      // Enqueue obsidian polling work to QUEUE_NORMAL
      const message: IngestionQueueMessage = {
        type: 'obsidian_note',
        tenantId: tenant.id,
        payload: {
          pollType: event.cron === '*/1 * * * *' ? 'folder' : 'vault_scan',
          sinceMs: lastPollMs,
        },
        enqueuedAt: Date.now(),
      }

      ctx.waitUntil(env.QUEUE_NORMAL.send(message))
      ctx.waitUntil(env.KV_SESSION.put(lastPollKey, String(Date.now())))
    }
  },
}
