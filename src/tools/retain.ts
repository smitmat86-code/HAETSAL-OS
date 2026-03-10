// src/tools/retain.ts
// TODO: Phase 2.1 — wire write policy validator (heuristic + classifier) before real retain
// TODO: Phase 2.1 — call Hindsight brain_retain API instead of returning stub

import type { RetainInput, RetainOutput } from '../types/tools'

export async function retainStub(input: RetainInput): Promise<RetainOutput> {
  // Stub — returns plausible structure so MCP callers can integrate
  // Real implementation: heuristic check → classifier if flagged → Hindsight write
  return {
    memory_id: crypto.randomUUID(),
    salience_tier: inferSalienceTier(input.content),
    status: 'retained',
  }
}

function inferSalienceTier(content: string): number {
  // Stub heuristic — real salience scorer wired in Phase 2.1
  if (content.length > 500) return 2
  return 1
}
