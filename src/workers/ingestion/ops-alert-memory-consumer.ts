// src/workers/ingestion/ops-alert-memory-consumer.ts
// Consumer for 'ops_alert_memory' jobs (spec M4). Encrypts with the Cron KEK
// — the webhook producer has no TMK. If the KEK is expired, retry with a
// long delay; it reprovisions on Matt's next authenticated session, and the
// alert itself was already delivered/recorded on the ingress path.

import type { Env } from '../../types/env'
import type { OpsAlertMemoryPayload } from '../../services/ops-alert/memory'
import { fetchAndValidateKek } from '../../cron/kek'
import { retainContent } from '../../services/ingestion/retain'

export async function processOpsAlertMemory(
  msg: Message<{ tenantId: string; payload: Record<string, unknown> }>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { tenantId } = msg.body
  const payload = msg.body.payload as unknown as OpsAlertMemoryPayload
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) {
    console.warn('OPS_ALERT_MEMORY_WAITING_FOR_KEK', { tenantId, messageId: msg.id })
    msg.retry({ delaySeconds: 300 })
    return
  }
  try {
    await retainContent({
      tenantId,
      source: 'ops_alert',
      content: payload.content,
      occurredAt: payload.occurredAt,
      memoryType: 'episodic',
      domain: 'general',
      provenance: `ops_alert:${payload.sourceId}`,
      metadata: { ops_alert: true, severity: payload.severity, source_id: payload.sourceId },
    }, kek, env, ctx)
    msg.ack()
  } catch (error) {
    console.error('OPS_ALERT_MEMORY_RETAIN_FAILED', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    msg.retry({ delaySeconds: 60 })
  }
}
