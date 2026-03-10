// src/workers/mcpagent/routes/ingest.ts
// Ingestion route handlers — thin transport (parse → enqueue → respond)
// Law 1 exception: POST /ingest/sms is NOT behind CF Access (Telnyx webhook)
// Telnyx Ed25519 signature validation replaces CF Access auth on this route

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import type { IngestionQueueMessage } from '../../../types/ingestion'

type Variables = { tenantId: string; jwtSub: string; traceId: string }
const ingest = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * Verify Telnyx Ed25519 webhook signature
 * Uses Web Crypto API (native in workerd) — no npm package needed
 */
async function verifyTelnyxSignature(
  body: string,
  signature: string,
  timestamp: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const publicKeyBytes = new Uint8Array(
      publicKeyHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)),
    )
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify'],
    )
    const signedPayload = `${timestamp}|${body}`
    const signatureBytes = new Uint8Array(
      atob(signature).split('').map(c => c.charCodeAt(0)),
    )
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signatureBytes,
      new TextEncoder().encode(signedPayload),
    )
  } catch {
    return false
  }
}

/**
 * POST /ingest/sms — Telnyx webhook receiver
 * Law 1 exception: NOT behind CF Access — documented
 * Validates Ed25519 signature → lookups tenant by phone → enqueues to QUEUE_HIGH
 */
ingest.post('/sms', async (c) => {
  const body = await c.req.text()
  const signature = c.req.header('telnyx-signature-ed25519') ?? ''
  const timestamp = c.req.header('telnyx-timestamp') ?? ''

  // Ed25519 signature validation
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
    // Unknown number — silent ignore (200 OK so Telnyx doesn't retry)
    return c.json({ status: 'ignored' }, 200)
  }

  // Enqueue to QUEUE_HIGH (SMS = 30s SLA)
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

export { ingest }
