import type { Hono } from 'hono'
import type { Env } from '../../types/env'
import { processSendblueInbound, type SendblueInboundBody } from '../../services/sendblue-inbound'

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
  app.post('/telegram/webhook', async (c) => {
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token')
    if (secret !== c.env.TELEGRAM_WEBHOOK_SECRET) return c.json({}, 403)

    try {
      const body = await c.req.json() as { message?: { chat?: { id: number }; text?: string } }
      const chatId = body.message?.chat?.id
      const text = body.message?.text
      if (!chatId) return c.json({ ok: true })

      await c.env.KV_SESSION.put('telegram_chat_id:default', String(chatId))
      if (text && !text.startsWith('/')) {
        const aiResponse = await (c.env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run(
          '@cf/meta/llama-3.1-8b-instruct',
          {
            messages: [
              {
                role: 'system' as const,
                content: 'You are Haetsal (해살), a warm and capable personal AI assistant. You communicate via Telegram. Keep responses concise and conversational — this is a chat, not email. Be helpful, natural, and brief. If asked to do something you can\'t do yet, be honest about it.',
              },
              { role: 'user' as const, content: text },
            ],
            max_tokens: 300,
          },
        ) as { response?: string }
        await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: aiResponse?.response ?? "I'm having trouble thinking right now. Try again in a moment.",
          }),
        })
      }
    } catch (err) {
      console.error('TG_FLOW: FAILED:', err instanceof Error ? err.message : String(err))
    }
    return c.json({ ok: true })
  })
}
