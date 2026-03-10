// src/workers/mcpagent/routes/ingest.ts
// Ingestion route handlers — thin transport (parse → enqueue → respond)
// Law 1 exception: POST /ingest/sms is NOT behind CF Access (Telnyx webhook)
// Telnyx Ed25519 signature validation replaces CF Access auth on this route

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import type { IngestionQueueMessage } from '../../../types/ingestion'
import { verifyTelnyxSignature } from '../../../services/telnyx'

type Variables = { tenantId: string; jwtSub: string; traceId: string }
const ingest = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * POST /ingest/sms — Telnyx webhook receiver
 * Law 1 exception: NOT behind CF Access — documented
 * Validates Ed25519 signature → lookups tenant by phone → enqueues to QUEUE_HIGH
 */
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

  const payload = JSON.parse(body) as {
    data: {
      payload: {
        from: { phone_number: string }
        to: { phone_number: string }[]
        text: string
        occurred_at: string
      }
    }
  }

  const smsPayload = payload.data.payload
  const fromPhone = smsPayload.from.phone_number

  // Lookup tenant by phone number
  const tenant = await c.env.D1_US.prepare(
    `SELECT tenant_id FROM tenant_phone_numbers WHERE phone_e164 = ?`,
  ).bind(fromPhone).first<{ tenant_id: string }>()

  if (!tenant) {
    return c.json({ status: 'ignored' }, 200)
  }

  const message: IngestionQueueMessage = {
    type: 'sms_inbound',
    tenantId: tenant.tenant_id,
    payload: {
      from: fromPhone,
      text: smsPayload.text,
      occurredAt: new Date(smsPayload.occurred_at).getTime(),
    },
    enqueuedAt: Date.now(),
  }

  await c.env.QUEUE_HIGH.send(message)
  return c.json({ status: 'enqueued' }, 200)
})

/**
 * POST /ingest/gmail — Google Push Notification for Gmail
 * Verifies channel token → enqueues thread ID to QUEUE_NORMAL
 */
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

/**
 * POST /ingest/calendar — Google Push Notification for Calendar
 * Verifies channel token → enqueues event ID to QUEUE_NORMAL
 */
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
