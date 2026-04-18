// src/tools/retain.ts
// MCP retain tool — retains immediately so user-authored writes are available right away.

import type { RetainInput, RetainOutput } from '../types/tools'
import type { Env } from '../types/env'
import { retainContent } from '../services/ingestion/retain'

/**
 * MCP retain via direct ingestion so interactive writes are visible to Hindsight
 * without depending on the separate ingestion queue consumer.
 */
export async function retainViaService(
  input: RetainInput,
  tenantId: string,
  tmk: CryptoKey | null,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<RetainOutput> {
  console.log('MCP_RETAIN_START', { tenantId, domain: input.domain, memoryType: input.memory_type ?? 'episodic' })
  if (!tmk) {
    // No TMK available — return deferred status
    console.warn('MCP_RETAIN_DEFERRED_NO_TMK', { tenantId })
    return {
      memory_id: '',
      salience_tier: 0,
      status: 'deferred',
    }
  }

  const result = await retainContent({
    tenantId,
    source: 'mcp_retain',
    content: input.content,
    occurredAt: Date.now(),
    memoryType: input.memory_type,
    domain: input.domain,
    provenance: input.provenance ?? 'mcp_retain',
  }, tmk, env, ctx, { hindsightAsync: true })

  console.log('MCP_RETAIN_DONE', {
    tenantId,
    memoryId: result?.memoryId ?? null,
    salienceTier: result?.salienceTier ?? null,
  })

  return {
    memory_id: result?.memoryId ?? '',
    salience_tier: result?.salienceTier ?? 0,
    status: result ? 'queued' : 'deferred',
  }
}
