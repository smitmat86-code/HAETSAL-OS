// src/tools/act/send-message.ts
// brain_v1_act_send_message — WRITE_EXTERNAL_IRREVERSIBLE
// Phase 1: stub — publishes to QUEUE_ACTIONS, no real send
// Phase 2.2: wire Telnyx SMS + Gmail integration

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const sendMessageSchema = z.object({
  recipient: z.string().describe('Phone (E.164) or email address'),
  message: z.string().describe('Message body text'),
  channel: z.enum(['sms', 'email']).optional().describe('Delivery channel'),
})

export async function sendMessageStub(
  input: z.infer<typeof sendMessageSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_send_message',
    capability_class: 'WRITE_EXTERNAL_IRREVERSIBLE',
    integration: input.channel ?? 'sms',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
