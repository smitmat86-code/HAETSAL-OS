import type { Hono } from 'hono'
import type { Env } from '../../types/env'
import { processSendblueInbound, type SendblueInboundBody } from '../../services/sendblue-inbound'
import { processTelegramInbound, type TelegramUpdate } from '../../services/telegram-inbound'
import { registerOpsAlertWebhook } from './ops-alert-webhook'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

/** Constant-time string comparison (crypto.subtle.timingSafeEqual needs equal lengths). */
function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean })
    .timingSafeEqual(leftBytes.buffer as ArrayBuffer, rightBytes.buffer as ArrayBuffer)
}

export function registerPublicWebhooks(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
): void {
  // M4 ops-alert ingress — Law 1 exception, per-source token (spec M4).
  registerOpsAlertWebhook(app)
  // Sendblue iMessage inbound (mission Phase 4). Law 1 exception path with a
  // CF Access bypass app; Sendblue does NOT sign webhooks, so auth is the
  // bearer path segment compared in constant time, plus a to_number check.
  app.post('/webhooks/sendblue/:pathSecret', async (c) => {
    const provided = c.req.param('pathSecret')
    const expected = c.env.SENDBLUE_WEBHOOK_PATH_SECRET
    if (!expected?.trim() || !timingSafeEqualStrings(provided, expected)) {
      return c.json({ error: 'not found' }, 404)
    }
    let body: SendblueInboundBody
    try {
      body = await c.req.json<SendblueInboundBody>()
    } catch {
      return c.json({ error: 'bad request' }, 400)
    }
    const lineNumber = body.to_number ?? body.number
    if (!lineNumber || lineNumber !== c.env.SENDBLUE_PHONE_NUMBER) {
      console.warn('SENDBLUE_WEBHOOK_WRONG_LINE', { suffix: (lineNumber ?? '').slice(-4) })
      return c.json({ status: 'ignored' }, 200)
    }
    let ctx: Pick<ExecutionContext, 'waitUntil'>
    try {
      ctx = c.executionCtx
    } catch {
      // No execution context outside the Workers runtime (tests); run inline.
      ctx = { waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}) } }
    }
    try {
      const outcome = await processSendblueInbound(body, c.env, ctx)
      return c.json({ status: outcome.handled ? 'processed' : 'ignored', kind: outcome.kind }, 200)
    } catch (error) {
      console.error('SENDBLUE_WEBHOOK_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ status: 'error' }, 200)
    }
  })
  // 14.3 queue-side chat: processTelegramInbound is enqueue-only for text
  // (two durable jobs, awaited so they exist before Telegram gets its 200)
  // and detaches the photo pipeline internally — so awaiting here is
  // milliseconds and the 14.2 timeout class (inline model calls blowing
  // Telegram's ~60s read window → cancel + redelivery storm) cannot recur.
  app.post('/telegram/webhook', async (c) => {
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
    if (secret !== c.env.TELEGRAM_WEBHOOK_SECRET) return c.json({}, 403)
    let update: TelegramUpdate
    try { update = await c.req.json<TelegramUpdate>() } catch { return c.json({ ok: true }) }
    let ctx: Pick<ExecutionContext, 'waitUntil'>
    try { ctx = c.executionCtx } catch {
      ctx = { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) } }
    }
    try {
      await processTelegramInbound(update, c.env, ctx)
    } catch (err) {
      console.error('TELEGRAM_WEBHOOK_FAILED', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return c.json({ ok: true })
  })
}
