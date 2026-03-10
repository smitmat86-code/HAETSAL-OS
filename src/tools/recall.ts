// src/tools/recall.ts
// TODO: Phase 2.1 — call Hindsight 4-way parallel retrieval instead of returning stub
// Real implementation: vector + graph + temporal + semantic parallel retrieval

import type { RecallInput, RecallOutput } from '../types/tools'

export async function recallStub(input: RecallInput): Promise<RecallOutput> {
  // Stub — real implementation does 4-way parallel retrieval via Hindsight
  return {
    results: [{
      memory_id: crypto.randomUUID(),
      content: `[Stub] No memories retained yet. Query was: "${input.query}"`,
      memory_type: 'episodic',
      confidence: 0,
      relevance: 0,
    }],
    synthesis: '[Stub] Memory system not yet connected. Hindsight wires in Phase 2.1.',
  }
}
