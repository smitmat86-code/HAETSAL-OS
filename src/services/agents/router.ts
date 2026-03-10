// src/services/agents/router.ts
// Layer 1 Router — pattern-first (~5ms), Workers AI classifier fallback (~200ms)
// LESSON: All Workers AI calls use { gateway: { id: 'brain-gateway' } }

import type { Env } from '../../types/env'
import type { AgentType } from '../../agents/types'

const ROUTING_PATTERNS: Array<{ pattern: RegExp; agent: AgentType }> = [
  { pattern: /\b(career|work|job|project|deadline|client|promotion)\b/i, agent: 'career_coach' },
  { pattern: /\b(workout|health|sleep|exercise|doctor|fitness)\b/i, agent: 'life_coach' },
  { pattern: /\b(budget|invoice|expense|payment|salary|finance)\b/i, agent: 'career_coach' },
  { pattern: /\b(relationship|friend|family|partner)\b/i, agent: 'chief_of_staff' },
  { pattern: /\b(remind|schedule|calendar|meeting|plan)\b/i, agent: 'chief_of_staff' },
]

const VALID_AGENTS: AgentType[] = ['chief_of_staff', 'career_coach', 'life_coach', 'inline']

export async function routeRequest(input: string, env: Env): Promise<AgentType> {
  // Pattern check — fast path (~5ms)
  for (const { pattern, agent } of ROUTING_PATTERNS) {
    if (pattern.test(input)) return agent
  }

  // Ambiguous — Workers AI 8B classifier fallback (~200ms)
  try {
    const result = await env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct' as BaseAiTextGenerationModels,
      {
        messages: [{
          role: 'user',
          content: `Classify this request into one category:
chief_of_staff (general planning, orchestration, multi-domain)
career_coach (work, projects, professional goals)
life_coach (health, relationships, personal growth)
inline (simple factual question, no agent needed)

Request: "${input.slice(0, 300)}"
Answer with exactly one category name.`,
        }],
      },
      { gateway: { id: 'brain-gateway' } },
    ) as AiTextGenerationOutput

    const response = typeof result === 'string' ? result
      : (result as { response?: string }).response ?? ''
    const classification = response.trim().toLowerCase().replace(/[^a-z_]/g, '')

    if (VALID_AGENTS.includes(classification as AgentType)) {
      return classification as AgentType
    }
  } catch {
    // Classifier failure — fall back to Chief of Staff
  }

  return 'chief_of_staff'
}
