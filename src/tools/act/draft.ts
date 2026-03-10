// src/tools/act/draft.ts
// brain_v1_act_draft — WRITE_INTERNAL
// Phase 1: stub — publishes to QUEUE_ACTIONS
// Phase 2: wire internal draft storage

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const draftSchema = z.object({
  title: z.string().describe('Draft title'),
  content: z.string().describe('Draft content body'),
  draft_type: z.enum(['email', 'note', 'plan']).optional().describe('Draft type'),
})

export async function draftStub(
  input: z.infer<typeof draftSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_draft',
    capability_class: 'WRITE_INTERNAL',
    integration: 'internal',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
