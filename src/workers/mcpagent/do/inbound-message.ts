import type { Env } from '../../../types/env'
import { sendSmsReply } from '../../../services/delivery/sms'
import { sendTelegramMessage } from '../../../services/delivery/telegram'
import { runGatewayChat } from '../../../services/workers-ai-chat'

/** DO fetch branch for POST /inbound, extracted for the McpAgent line limit. */
export async function handleInboundPost(
  request: Request,
  env: Env,
  adoptTenant: (tenantId: string) => void,
): Promise<Response> {
  const { tenantId, text, channel, replyTo } = await request.json() as {
    tenantId: string; text: string; channel: 'sms' | 'telegram'; replyTo: string
  }
  adoptTenant(tenantId)
  const result = await processInboundMessage(env, tenantId, text, channel, replyTo)
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
}

export async function processInboundMessage(
  env: Env,
  tenantId: string,
  text: string,
  channel: 'sms' | 'telegram',
  replyTo: string,
): Promise<{ reply: string; success: boolean }> {
  try {
    const messages = [
      {
        role: 'system' as const,
        content: `You are Haetsal (해살), a warm and capable personal AI assistant. You communicate via ${channel === 'sms' ? 'text message' : 'Telegram'}. Keep responses concise and conversational — this is a chat, not email. Be helpful, natural, and brief. If asked to do something you can't do yet, be honest about it.`,
      },
      { role: 'user' as const, content: text },
    ]
    const response = await runGatewayChat(env, messages)

    const reply = response ?? "I'm having trouble thinking right now. Try again in a moment."
    if (channel === 'sms') {
      await sendSmsReply(replyTo, reply, env)
    } else {
      await sendTelegramMessage(tenantId, reply, env)
    }
    return { reply, success: true }
  } catch (err) {
    console.error('processInboundMessage FAILED:', err instanceof Error ? err.message : String(err))
    return { reply: '', success: false }
  }
}
