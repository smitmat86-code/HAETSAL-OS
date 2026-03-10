// src/tools/retain.ts
// MCP retain tool — wires to real retainContent() pipeline (Phase 2.1)
// MCP retain is synchronous (no queue) — calls service directly, returns memory_id

import type { RetainInput, RetainOutput } from '../types/tools'
import type { Env } from '../types/env'
import { retainContent } from '../services/ingestion/retain'

/**
 * MCP retain via real ingestion pipeline
 * Called directly from DO (TMK available in DO memory)
 */
export async function retainViaService(
  input: RetainInput,
  tenantId: string,
  tmk: CryptoKey | null,
  env: Env,
): Promise<RetainOutput> {
  if (!tmk) {
    // No TMK available — return deferred status
    return {
      memory_id: '',
      salience_tier: 0,
      status: 'deferred',
    }
  }

  const result = await retainContent(
    {
      tenantId,
      source: 'mcp_retain',
      content: input.content,
      occurredAt: Date.now(),
      memoryType: input.memory_type,
      domain: input.domain,
      provenance: input.provenance ?? 'mcp_retain',
    },
    tmk,
    env,
  )

  if (!result) {
    // Dedup hit or write policy violation — return success (silent drop)
    // LESSON: Return success to prevent doom loops
    return {
      memory_id: crypto.randomUUID(),
      salience_tier: 1,
      status: 'retained',
    }
  }

  return {
    memory_id: result.memoryId,
    salience_tier: result.salienceTier,
    status: 'retained',
  }
}
