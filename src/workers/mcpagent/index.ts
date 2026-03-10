// src/workers/mcpagent/index.ts — Hono app route registrations
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
import { handleObsidianPoll } from '../../cron/obsidian-poll'
import { handleMorningBrief } from '../../cron/morning-brief'
import { runPredictiveHeartbeat } from '../../cron/heartbeat'
import { runWeeklySynthesis } from '../../cron/weekly-synthesis'
import { runConsolidationPasses, handleNightlyConsolidation } from '../../cron/consolidation'
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
app.route('/ingest', ingest)

// Telegram webhook — Law 1 exception: validated via secret token, not CF Access
app.post('/telegram/webhook', async (c) => {
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  if (secret !== c.env.TELEGRAM_WEBHOOK_SECRET) return c.json({}, 403)
  return c.json({ ok: true }) // Phase 3.4: ack only — full /start flow Phase 5+
})

// Hindsight webhook — Law 1 exception: HMAC-SHA256 validated, not CF Access
app.post('/hindsight/webhook', async (c) => {
  const sig = c.req.header('X-Hindsight-Signature')
  const body = await c.req.text()
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(c.env.HINDSIGHT_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const expected = btoa(String.fromCharCode(
    ...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
  ))
  if (sig !== expected) return c.json({}, 403)
  const payload = JSON.parse(body) as { event_type?: string; bank_id?: string }
  if (payload.event_type === 'consolidation.completed' && payload.bank_id) {
    c.executionCtx.waitUntil(runConsolidationPasses(payload.bank_id, c.env, c.executionCtx))
  }
  return c.json({ ok: true })
})

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
  // Cron dispatch — each expression routes to its handler module
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case '*/1 * * * *':
      case '*/15 * * * *':  return handleObsidianPoll(event, env, ctx)
      case '0 7 * * *':     return handleMorningBrief(env, ctx)
      case '*/30 * * * *':  return runPredictiveHeartbeat(env, ctx)
      case '0 17 * * 5':    return runWeeklySynthesis(env, ctx)
      case '0 2 * * *':     return handleNightlyConsolidation(env, ctx)
    }
  },
}
