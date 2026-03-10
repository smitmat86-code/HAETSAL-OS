// src/tools/act/search.ts
// brain_v1_act_search — READ
// Phase 1: stub — publishes to QUEUE_ACTIONS
// Phase 2: wire web search provider

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const searchSchema = z.object({
  query: z.string().describe('Search query string'),
  domain: z.string().optional().describe('Optional domain to restrict'),
  max_results: z.number().optional().describe('Max results to return'),
})

export async function searchStub(
  input: z.infer<typeof searchSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_search',
    capability_class: 'READ',
    integration: 'web',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
