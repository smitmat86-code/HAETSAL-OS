import type { Hono } from 'hono'
import type { Env } from '../../types/env'
import { runConsolidationPasses } from '../../cron/consolidation'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

export function registerPublicWebhooks(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
): void {
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
}
