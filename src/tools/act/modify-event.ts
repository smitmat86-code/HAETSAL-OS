// src/tools/act/modify-event.ts
// brain_v1_act_modify_event — WRITE_EXTERNAL_REVERSIBLE
// Phase 1: stub — publishes to QUEUE_ACTIONS
// Phase 2.3: wire Google Calendar API

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const modifyEventSchema = z.object({
  event_id: z.string().describe('Calendar event ID to modify'),
  title: z.string().optional().describe('Updated title'),
  start_time: z.string().optional().describe('Updated ISO 8601 start'),
  end_time: z.string().optional().describe('Updated ISO 8601 end'),
  description: z.string().optional().describe('Updated description'),
})

export async function modifyEventStub(
  input: z.infer<typeof modifyEventSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_modify_event',
    capability_class: 'WRITE_EXTERNAL_REVERSIBLE',
    integration: 'calendar',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
