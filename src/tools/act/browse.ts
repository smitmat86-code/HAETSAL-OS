// src/tools/act/browse.ts
// brain_v1_act_browse — READ
// Phase 1: stub — publishes to QUEUE_ACTIONS
// Phase 2.3: wire Cloudflare Browser Rendering via BROWSER binding

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const browseSchema = z.object({
  url: z.string().url().describe('URL to browse'),
  extract: z.enum(['text', 'screenshot', 'both']).optional().describe('What to extract'),
})

export async function browseStub(
  input: z.infer<typeof browseSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_browse',
    capability_class: 'READ',
    integration: 'web',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
