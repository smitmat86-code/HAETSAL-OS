// src/tools/act/run-playbook.ts
// brain_v1_act_run_playbook — WRITE_EXTERNAL_IRREVERSIBLE
// Phase 1: stub — publishes to QUEUE_ACTIONS
// Phase 5.3: wire full playbook execution engine

import { z } from 'zod'
import { hashPayload } from '../../services/action/toctou'
import type { ActionQueueMessage } from '../../types/action'

export const runPlaybookSchema = z.object({
  playbook_name: z.string().describe('Playbook template name'),
  parameters: z.record(z.string()).optional().describe('Key-value parameters'),
})

export async function runPlaybookStub(
  input: z.infer<typeof runPlaybookSchema>,
  env: { QUEUE_ACTIONS: Queue }, tenantId: string, proposedBy: string
): Promise<{ action_id: string; status: 'proposed' }> {
  const action_id = crypto.randomUUID()
  const payload_stub = JSON.stringify(input)
  const payload_hash = await hashPayload(payload_stub)
  await env.QUEUE_ACTIONS.send({
    action_id, tenant_id: tenantId, proposed_by: proposedBy,
    tool_name: 'brain_v1_act_run_playbook',
    capability_class: 'WRITE_EXTERNAL_IRREVERSIBLE',
    integration: 'multi',
    payload_r2_key: `actions/${tenantId}/${action_id}`,
    payload_hash, payload_stub,
  } satisfies ActionQueueMessage)
  return { action_id, status: 'proposed' }
}
