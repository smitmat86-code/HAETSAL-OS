// src/cron/passes/pass1-contradiction.ts
// Contradiction detection uses Hindsight list/history structural signals before LLM review.

import type { Env } from '../../types/env'
import { fetchMemoryHistory, listMemories } from '../../services/hindsight'

interface HistoryEntry { version: number; content: string; updated_at: string }
interface MemoryListItem { id: string; memory_type: string }
interface ContradictionResult {
  memory_id: string
  resolution: 'genuine_contradiction' | 'natural_update' | 'ambiguous'
}

export async function runPass1(
  bankId: string, kek: CryptoKey, env: Env,
): Promise<number> {
  void kek

  const params = new URLSearchParams({ memory_type: 'semantic', limit: '50' })
  const { memories } = await listMemories<MemoryListItem>(bankId, params, env)
    .catch(() => ({ memories: [] }))
  if (!memories?.length) return 0

  const candidates: Array<{ id: string; versions: HistoryEntry[] }> = []
  await Promise.allSettled(memories.map(async (memory) => {
    const historyRes = await fetchMemoryHistory<HistoryEntry>(bankId, memory.id, env)
    if (!historyRes?.history?.length || historyRes.history.length < 2) return
    candidates.push({ id: memory.id, versions: historyRes.history })
  }))

  if (!candidates.length) return 0

  const prompt = candidates.slice(0, 10).map(candidate =>
    `Memory ${candidate.id}:\n  Old: ${candidate.versions[0].content.slice(0, 200)}\n  New: ${candidate.versions[candidate.versions.length - 1].content.slice(0, 200)}`,
  ).join('\n\n')

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    { messages: [{ role: 'user', content:
      `Review these memory pairs where the observation changed. For each: determine if genuine contradiction, natural update, or ambiguous. Return JSON: {"results":[{"memory_id":"...","resolution":"genuine_contradiction"|"natural_update"|"ambiguous"}]}\n\n${prompt}` }] },
    { gateway: { id: env.AI_GATEWAY_ID } },
  ) as { response?: string }

  let results: ContradictionResult[] = []
  try { results = JSON.parse(result.response ?? '{}').results ?? [] } catch { /* parse fail */ }

  let count = 0
  for (const contradiction of results) {
    if (contradiction.resolution === 'genuine_contradiction' || contradiction.resolution === 'ambiguous') {
      const type = contradiction.resolution === 'genuine_contradiction'
        ? 'memory.contradiction' : 'memory.contradiction_unresolved'
      await env.D1_US.prepare(
        `INSERT OR IGNORE INTO anomaly_signals
         (id, tenant_id, created_at, signal_type, severity, detail_json)
         VALUES (?, (SELECT tenant_id FROM consolidation_runs ORDER BY started_at DESC LIMIT 1), ?, ?, 'medium', ?)`,
      ).bind(
        crypto.randomUUID(),
        Date.now(),
        type,
        JSON.stringify({ memory_id: contradiction.memory_id }),
      ).run()
      count++
    }
  }

  return count
}
