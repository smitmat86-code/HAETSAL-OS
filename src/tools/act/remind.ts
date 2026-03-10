// src/tools/act/remind.ts
// brain_v1_act_remind — WRITE_INTERNAL
// Phase 1: stub — publishes to QUEUE_ACTIONS
// Phase 2: wire scheduled_tasks + notification system

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const remindSchema = z.object({
  message: z.string().describe('Reminder message text'),
  remind_at: z.string().describe('ISO 8601 datetime for reminder'),
  channel: z.enum(['sms', 'push', 'both']).optional().describe('Notification channel'),
})

export async function remindStub(
  input: z.infer<typeof remindSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_remind',
    capability_class: 'WRITE_INTERNAL',
    integration: 'internal',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
