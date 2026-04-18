// src/tools/recall.ts
// Hindsight recall via the official v1 API.
// Queries are sent as plaintext; HAETSAL keeps encryption only for its own archives.

import type { RecallInput, RecallOutput } from '../types/tools'
import type { Env } from '../types/env'
import type { HindsightRecallResponse, HindsightRecallResult } from '../types/hindsight'
import { buildHindsightTags, recallMemory } from '../services/hindsight'

function normalizeRecallResults(data: HindsightRecallResponse): RecallOutput['results'] {
  const rawResults = data.results ?? data.items ?? data.memories ?? []
  return rawResults.map((raw: HindsightRecallResult, index) => ({
    memory_id: String(raw.id ?? raw.memory_id ?? `hindsight-result-${index}`),
    content: String(raw.text ?? raw.content ?? raw.content_preview ?? raw.summary ?? ''),
    memory_type: String(
      raw.type
      ?? raw.fact_type
      ?? raw.memory_type
      ?? raw.metadata?.app_memory_type
      ?? 'memory',
    ),
    confidence: Number(raw.confidence ?? raw.score ?? 0),
    relevance: Number(raw.relevance ?? raw.score ?? raw.confidence ?? 0),
  }))
}

/**
 * Recall via Hindsight — called from DO where tenant context is already available.
 */
export async function recallViaService(
  input: RecallInput,
  tenantId: string,
  _tmk: CryptoKey | null,
  env: Env,
): Promise<RecallOutput> {
  const tags = input.domain
    ? buildHindsightTags(tenantId, input.domain)
    : buildHindsightTags(tenantId)

  const data = await recallMemory(tenantId, {
    query: input.query,
    budget: 'mid',
    max_tokens: Math.max((input.limit ?? 10) * 512, 1024),
    query_timestamp: new Date().toISOString(),
    tags,
    tags_match: 'all_strict',
  }, env)

  const results = normalizeRecallResults(data)

  return {
    results,
    synthesis: data.text
      ?? (results.length > 0
        ? `Found ${results.length} relevant memories.`
        : 'No matching memories found.'),
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
