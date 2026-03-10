// src/workers/mcpagent/index.ts
// Hono app — route registrations only
// Queue handlers for both actions and ingestion
// Middleware order: security headers → auth → audit → dlp (MCP routes) → handler
// LESSON: Security headers in try/finally — skip on WebSocket 101 responses
// LESSON: Queue consumers export queue() alongside fetch() — no separate Worker needed
// Route extraction (2.1): /ingest/* and /auth/* in separate route modules

import { Hono } from 'hono'
import { McpAgentDO } from './do/McpAgent'
import { authMiddleware } from '../../middleware/auth'
import { auditMiddleware } from '../../middleware/audit'
import { dlpMiddleware } from '../../middleware/dlp'
import { ingest } from './routes/ingest'
import { auth } from './routes/auth'
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
      await handleActionBatch(batch as MessageBatch<ActionQueueMessage>, env)
    } else {
      // QUEUE_HIGH, QUEUE_NORMAL, QUEUE_BULK → ingestion consumer
      await handleIngestionBatch(
        batch as MessageBatch<IngestionQueueMessage>, env, ctx,
      )
    }
  },
}
