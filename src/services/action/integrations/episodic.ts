// src/services/action/integrations/episodic.ts
// Automatic episodic memory on successful action execution
// Law 3: memory_type = 'episodic' — no procedural writes

import type { Env } from '../../../types/env'
import type { ActionQueueMessage } from '../../../types/action'
import type { IngestionArtifact } from '../../../types/ingestion'
import { retainContent } from '../../ingestion/retain'

/**
 * Write episodic memory after action execution — non-fatal
 * Content is action metadata only (not the actual content of the action)
 */
export async function writeActionEpisodicMemory(
  msg: ActionQueueMessage,
  externalId: string | undefined,
  htmlLink: string | undefined,
  tmk: CryptoKey,
  env: Env,
): Promise<void> {
  try {
    const artifact: IngestionArtifact = {
      source: 'mcp_retain',
      tenantId: msg.tenant_id,
      content: `Action executed: ${msg.tool_name} via ${msg.integration} at ${new Date().toISOString()}`,
      occurredAt: Date.now(),
      provenance: 'action_execution',
      memoryType: 'episodic',
      domain: 'general',
      metadata: {
        action_id: msg.action_id,
        tool_name: msg.tool_name,
        integration: msg.integration,
        ...(externalId ? { external_id: externalId } : {}),
        ...(htmlLink ? { external_link: htmlLink } : {}),
      },
    }
    const result = await retainContent(artifact, tmk, env)
    if (result) {
      await env.D1_US.prepare(
        'UPDATE pending_actions SET episodic_memory_id = ? WHERE id = ?',
      ).bind(result.memoryId, msg.action_id).run()
    }
  } catch {
    // Episodic memory failure is non-fatal — action already executed
  }
}
