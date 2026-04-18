import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import type { IngestionQueueMessage } from '../../../types/ingestion'
import { verifyTelnyxSignature } from '../../../services/telnyx'

type Variables = { tenantId: string; jwtSub: string; traceId: string }
const ingest = new Hono<{ Bindings: Env; Variables: Variables }>()

ingest.post('/sms', async (c) => {
  const body = await c.req.text()
  const signature = c.req.header('telnyx-signature-ed25519') ?? ''
  const timestamp = c.req.header('telnyx-timestamp') ?? ''

  const valid = await verifyTelnyxSignature(
    body, signature, timestamp, c.env.TELNYX_PUBLIC_KEY,
  )
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 403)
  }

  const event = JSON.parse(body) as {
    data: {
      event_type?: string
      occurred_at?: string
      payload?: {
        from?: { phone_number?: string }
        to?: { phone_number?: string }[]
        text?: string
      }
    }
  }

  if (event.data.event_type !== 'message.received') {
    return c.json({ status: 'ack' }, 200)
  }

  const smsPayload = event.data.payload
  const fromPhone = smsPayload?.from?.phone_number
  const text = smsPayload?.text

  if (!fromPhone || !text) {
    return c.json({ status: 'ignored' }, 200)
  }

  const tenant = await c.env.D1_US.prepare(
    `SELECT tenant_id FROM tenant_phone_numbers WHERE phone_e164 = ?`,
  ).bind(fromPhone).first<{ tenant_id: string }>()

  if (!tenant) {
    return c.json({ status: 'ignored' }, 200)
  }

  try {
    console.log('SMS_FLOW: step1 — calling AI for text:', text.substring(0, 50))
    const aiMessages = [
      {
        role: 'system' as const,
        content: 'You are Haetsal (해살), a warm and capable personal AI assistant. You communicate via text message. Keep responses concise and conversational — this is a chat, not email. Be helpful, natural, and brief. If asked to do something you can\'t do yet, be honest about it.',
      },
      { role: 'user' as const, content: text },
    ]
    const aiResponse = await (c.env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run(
      '@cf/meta/llama-3.1-8b-instruct',
      { messages: aiMessages, max_tokens: 300 },
    ) as { response?: string }
    const reply = aiResponse?.response ?? "I'm having trouble thinking right now. Try again in a moment."
    console.log('SMS_FLOW: step2 — AI replied, length:', reply.length)
    const { sendSmsReply } = await import('../../../services/delivery/sms')
    const sent = await sendSmsReply(fromPhone, reply, c.env)
    console.log('SMS_FLOW: step3 — SMS send result:', sent)
  } catch (err) {
    console.error('SMS_FLOW: FAILED:', err instanceof Error ? err.message : String(err))
  }

  const message: IngestionQueueMessage = {
    type: 'sms_inbound',
    tenantId: tenant.tenant_id,
    payload: {
      from: fromPhone,
      text,
      occurredAt: event.data.occurred_at ? new Date(event.data.occurred_at).getTime() : Date.now(),
    },
    enqueuedAt: Date.now(),
  }
  c.executionCtx.waitUntil(c.env.QUEUE_HIGH.send(message))

  return c.json({ status: 'processed' }, 200)
})

ingest.post('/gmail', async (c) => {
  const channelToken = c.req.header('x-goog-channel-token') ?? ''
  const { verifyGoogleChannelToken } = await import('../../../services/google/webhook')

  const verified = await verifyGoogleChannelToken(channelToken, c.env)
  if (!verified || verified.resourceType !== 'gmail') {
    return c.json({ error: 'Invalid channel token' }, 403)
  }

  const body = await c.req.json() as { historyId?: string }
  const message: IngestionQueueMessage = {
    type: 'gmail_thread',
    tenantId: verified.tenantId,
    payload: { historyId: body.historyId ?? '' },
    enqueuedAt: Date.now(),
  }

  await c.env.QUEUE_NORMAL.send(message)
  return c.json({ status: 'enqueued' }, 200)
})

ingest.post('/calendar', async (c) => {
  const channelToken = c.req.header('x-goog-channel-token') ?? ''
  const { verifyGoogleChannelToken } = await import('../../../services/google/webhook')

  const verified = await verifyGoogleChannelToken(channelToken, c.env)
  if (!verified || verified.resourceType !== 'calendar') {
    return c.json({ error: 'Invalid channel token' }, 403)
  }

  const resourceId = c.req.header('x-goog-resource-id') ?? ''
  const message: IngestionQueueMessage = {
    type: 'calendar_event',
    tenantId: verified.tenantId,
    payload: { resourceId },
    enqueuedAt: Date.now(),
  }

  await c.env.QUEUE_NORMAL.send(message)
  return c.json({ status: 'enqueued' }, 200)
})

export { ingest }
