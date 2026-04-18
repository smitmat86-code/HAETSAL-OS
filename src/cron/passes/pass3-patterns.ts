// src/cron/passes/pass3-patterns.ts
// Behavioral pattern extraction — SOLE PROCEDURAL WRITE PATH
// consolidationRetain() is module-private, NOT exported
// This is the ONLY place in the entire codebase that writes memory_type: 'procedural'

import type { Env } from '../../types/env'
import type { IngestionArtifact } from '../../types/ingestion'
import { recallViaService } from '../../tools/recall'
import { retainContent } from '../../services/ingestion/retain'

interface PatternResult {
  pattern: string; confidence: number; domain: string; evidence_count: number
}

/** Module-private procedural write — NOT exported outside src/cron/ */
async function consolidationRetain(
  content: string, domain: string, provenance: string,
  tenantId: string, kek: CryptoKey, env: Env,
): Promise<void> {
  const artifact: IngestionArtifact = {
    tenantId, content, source: 'cron:consolidation',
    memoryType: 'procedural' as IngestionArtifact['memoryType'],
    domain, provenance, occurredAt: Date.now(),
  }
  // retainContent's write policy blocks 'procedural' from agents
  // but consolidationRetain bypasses by using the cron source identity
  await retainContent(artifact, kek, env).catch(() => {})
}

export async function runPass3(
  bankId: string, tenantId: string, kek: CryptoKey, env: Env,
): Promise<number> {
  // Recall episodic memories from last 30 days (session provenance)
  const result = await recallViaService(
    { query: 'session decisions actions patterns last month', limit: 50 },
    tenantId, kek, env,
  )
  if (!result.results.length) return 0

  const sessionContent = result.results
    .slice(0, 20)
    .map(r => r.content.slice(0, 300))
    .join('\n---\n')

  const llmResult = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    { messages: [{ role: 'user', content:
      `Extract behavioral patterns from these session memories. A behavioral pattern is a recurring tendency visible across multiple sessions. Return JSON: {"patterns":[{"pattern":"1-2 sentences","confidence":0.0-1.0,"domain":"string","evidence_count":number}]}. Only confidence > 0.6. Max 3.\n\n${sessionContent}` }] },
    { gateway: { id: env.AI_GATEWAY_ID } },
  ) as { response?: string }

  let patterns: PatternResult[] = []
  try { patterns = JSON.parse(llmResult.response ?? '{}').patterns ?? [] } catch { /* parse fail */ }

  // Only retain high-confidence patterns as procedural
  let count = 0
  for (const p of patterns.filter(p => p.confidence > 0.6).slice(0, 3)) {
    await consolidationRetain(p.pattern, p.domain, 'pass3_behavioral', tenantId, kek, env)
    count++
  }
  return count
}
