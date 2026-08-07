// src/workers/mcpagent/ops-alert-webhook.ts
// M4 ops-alert ingress: POST /ops/alert/:token — Law 1 exception path with
// the same posture as the Sendblue webhook (same hostname, no new public
// surface, per-source bearer token in the path because minimal senders like
// the health canary cannot set headers). Unknown/disabled token → 404.

import type { Hono } from 'hono'
import type { Env } from '../../types/env'
import type { OpsAlertPayload } from '../../types/ops-alert'
import { resolveOpsAlertSource } from '../../services/ops-alert/registry'
import { processOpsAlert } from '../../services/ops-alert/ingest'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

export function registerOpsAlertWebhook(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
): void {
  app.post('/ops/alert/:token', async (c) => {
    const source = await resolveOpsAlertSource(c.req.param('token'), c.env)
    if (!source) return c.json({ error: 'not found' }, 404)

    let payload: OpsAlertPayload
    try {
      payload = await c.req.json<OpsAlertPayload>()
    } catch {
      return c.json({ error: 'bad request' }, 400)
    }

    let ctx: Pick<ExecutionContext, 'waitUntil'>
    try {
      ctx = c.executionCtx
    } catch {
      // No execution context outside the Workers runtime (tests); run inline.
      ctx = { waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}) } }
    }

    try {
      const result = await processOpsAlert(source, payload, c.env, ctx)
      return c.json({ status: result.outcome, alert_id: result.alertId }, 200)
    } catch (error) {
      console.error('OPS_ALERT_INGRESS_FAILED', {
        source: source.id,
        error: error instanceof Error ? error.message : String(error),
      })
      // 500 so a well-behaved sender can retry; dedupe makes replays safe.
      return c.json({ status: 'error' }, 500)
    }
  })
}
