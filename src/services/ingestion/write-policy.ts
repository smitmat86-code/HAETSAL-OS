// src/services/ingestion/write-policy.ts
// Write policy validator: prevents procedural memory writes from domain agents (Law 3)
// Two-stage: regex heuristic first (cheap), Workers AI classifier only if flagged
// LESSON: Heuristic before classifier — ~80-90% of episodic writes clear without AI cost
// LESSON: Silent drop, not error — return success to prevent doom loops

import type { Env } from '../../types/env'

export interface WritePolicyResult {
  isProcedural: boolean
  method: 'explicit_type' | 'heuristic' | 'classifier' | 'heuristic_pass'
}

// Sweeping language patterns that signal procedural memory
// LESSON: "always", "never", "tends to", "avoids", "prefers when", "is the type of person"
const PROCEDURAL_PATTERNS = [
  /\b(always|never|every\s+time)\b/i,
  /\b(tends?\s+to|usually|typically|habitually)\b/i,
  /\b(avoids?|prefers?\s+when|is\s+the\s+(?:type|kind)\s+of\s+person)\b/i,
  /\b(behavioral?\s+pattern|personality\s+trait)\b/i,
  /\b(whenever\s+\w+\s+(?:he|she|they|I)\b)/i,
]

/**
 * Run the write policy validator
 * Stage 1: regex heuristic (PROCEDURAL_PATTERNS)
 * Stage 2: Workers AI classifier (only if heuristic flags)
 */
export async function runWritePolicyValidator(
  content: string,
  inferredMemoryType: string,
  env: Env,
): Promise<WritePolicyResult> {
  // Short-circuit: explicit procedural type → immediate drop
  if (inferredMemoryType === 'procedural') {
    return { isProcedural: true, method: 'explicit_type' }
  }

  // Stage 1: regex heuristic
  const flagged = PROCEDURAL_PATTERNS.some(p => p.test(content))
  if (!flagged) {
    return { isProcedural: false, method: 'heuristic_pass' }
  }

  // Stage 2: Workers AI classifier (only if heuristic flags)
  try {
    const response = await env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct' as keyof AiModels,
      {
        messages: [
          {
            role: 'system',
            content: 'You are a memory type classifier. Respond with ONLY "procedural" or "episodic". Procedural memories describe behavioral patterns, habits, or personality traits. Episodic memories describe specific events, facts, or observations.',
          },
          {
            role: 'user',
            content: `Classify this memory: "${content.slice(0, 500)}"`,
          },
        ],
      },
      { gateway: { id: env.AI_GATEWAY_ID } },
    )

    const text = typeof response === 'string'
      ? response
      : (response as { response?: string }).response ?? ''
    const isProcedural = text.toLowerCase().includes('procedural')
    return { isProcedural, method: 'classifier' }
  } catch {
    // Classifier failure → pass through (fail open for writes, log anomaly separately)
    return { isProcedural: false, method: 'heuristic_pass' }
  }
}
