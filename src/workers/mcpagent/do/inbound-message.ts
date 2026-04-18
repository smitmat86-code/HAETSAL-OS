import type { Env } from '../../../types/env'
import { sendSmsReply } from '../../../services/delivery/sms'
import { sendTelegramMessage } from '../../../services/delivery/telegram'

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
    const response = await (env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run(
      '@cf/meta/llama-3.1-8b-instruct',
      { messages, max_tokens: 300 },
    ) as { response?: string }

    const reply = response?.response ?? "I'm having trouble thinking right now. Try again in a moment."
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
