// src/tools/recall.ts
// Canonical memory recall via the broker (legacy Hindsight reads severed in mission phase 3).
// Queries route through searchCanonicalMemory (mode: 'semantic').

import type { RecallInput, RecallOutput } from '../types/tools'
import type { Env } from '../types/env'
import { searchCanonicalMemory } from '../services/canonical-memory-query'

/**
 * Recall via canonical memory broker — called from DO where tenant context is available.
 * Hindsight recall retired in mission phase 3; routes through searchCanonicalMemory (mode: 'semantic').
 */
export async function recallViaService(
  input: RecallInput,
  tenantId: string,
  tmk: CryptoKey | null,
  env: Env,
): Promise<RecallOutput> {
  const result = await searchCanonicalMemory(
    {
      tenantId,
      query: input.query,
      scope: input.domain ?? null,
      limit: input.limit ?? 10,
      mode: 'semantic',
    },
    env,
    tenantId,
    { tmk },
  )

  const results = result.items.map((item, index) => ({
    memory_id: item.documentId ?? `canonical-result-${index}`,
    content: item.preview ?? item.title ?? '',
    memory_type: item.scope ?? 'memory',
    confidence: 0,
    relevance: 0,
  }))

  return {
    results,
    synthesis: results.length > 0
      ? `Found ${results.length} relevant memories.`
      : 'No matching memories found.',
  }
}

// Keep stub export for backward compatibility with tests
export async function recallStub(input: RecallInput): Promise<RecallOutput> {
  return {
    results: [{
      memory_id: crypto.randomUUID(),
      content: `[Stub] Query: "${input.query}"`,
      memory_type: 'experience',
      confidence: 0,
      relevance: 0,
    }],
    synthesis: '[Stub] Recall stub — use recallViaService for real recall.',
  }
}
