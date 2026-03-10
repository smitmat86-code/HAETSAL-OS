// src/tools/act/create-event.ts
// brain_v1_act_create_event — WRITE_EXTERNAL_REVERSIBLE
// Phase 1: stub — publishes to QUEUE_ACTIONS, no real calendar call
// Phase 2.3: wire Google Calendar API

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const createEventSchema = z.object({
  title: z.string().describe('Event title'),
  start_time: z.string().describe('ISO 8601 start time'),
  end_time: z.string().describe('ISO 8601 end time'),
  description: z.string().optional().describe('Event description'),
  attendees: z.array(z.string()).optional().describe('Email addresses'),
})

export async function createEventStub(
  input: z.infer<typeof createEventSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_create_event',
    capability_class: 'WRITE_EXTERNAL_REVERSIBLE',
    integration: 'calendar',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
