// src/services/ops-alert/memory.ts
// Async episodic memory for ops alerts (ADR-0006: alerts become memories).
// Uses a dedicated 'ops_alert_memory' queue job encrypted consumer-side with
// the Cron KEK — the unauthenticated webhook path has no TMK, and the plain
// retain_artifact job would throw 'requires TMK or pre-encrypted content'
// in the consumer (review M4 finding #1).

import type { Env } from '../../types/env'
import type { NormalizedOpsAlert, OpsAlertSource } from '../../types/ops-alert'

export interface OpsAlertMemoryPayload {
  sourceId: string
  severity: string
  content: string
  occurredAt: number
}

export function queueAlertMemory(
  source: OpsAlertSource,
  alert: NormalizedOpsAlert,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): void {
  const occurredAt = Date.now()
  // Date-stamped so a recurrence months later is a NEW memory — the retain
  // dedup hash is permanent, and an outage in March must not swallow July's.
  const day = new Date(occurredAt).toISOString().slice(0, 10)
  const content = `Ops alert (${alert.severity}) from ${source.id} on ${day}: ${alert.title}`
    + (alert.body && alert.body !== alert.title ? ` — ${alert.body}` : '')
  const payload: OpsAlertMemoryPayload = {
    sourceId: source.id, severity: alert.severity, content, occurredAt,
  }
  ctx.waitUntil(env.QUEUE_NORMAL.send({
    type: 'ops_alert_memory',
    tenantId: source.tenant_id,
    payload,
    enqueuedAt: occurredAt,
  }).catch((error) => {
    console.error('OPS_ALERT_MEMORY_ENQUEUE_FAILED', {
      source: source.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }))
}
