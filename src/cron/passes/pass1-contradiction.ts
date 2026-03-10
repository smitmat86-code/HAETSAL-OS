// src/cron/passes/pass1-contradiction.ts
// Contradiction detection — uses Hindsight /memories/list + /history
// LESSON: Pattern-first before LLM — structural signal filters candidates

import type { Env } from '../../types/env'

interface HistoryEntry { version: number; content: string; updated_at: string }
interface MemoryListItem { id: string; memory_type: string }
interface ContradictionResult {
  memory_id: string
  resolution: 'genuine_contradiction' | 'natural_update' | 'ambiguous'
}

export async function runPass1(
  bankId: string, kek: CryptoKey, env: Env,
): Promise<number> {
  // List semantic memories (structural — no decryption)
  const listRes = await env.HINDSIGHT.fetch(
    `http://hindsight/v1/default/banks/${bankId}/memories/list?memory_type=semantic&limit=50`,
  )
  if (!listRes.ok) return 0
  const { memories } = await listRes.json() as { memories: MemoryListItem[] }
  if (!memories?.length) return 0

  // Check history for each — find those with 2+ versions (potential contradiction)
  const candidates: Array<{ id: string; versions: HistoryEntry[] }> = []
  await Promise.allSettled(memories.map(async (m) => {
    const histRes = await env.HINDSIGHT.fetch(
      `http://hindsight/v1/default/banks/${bankId}/memories/${m.id}/history`,
    )
    if (!histRes.ok) return
    const { history } = await histRes.json() as { history: HistoryEntry[] }
    if (history && history.length >= 2) candidates.push({ id: m.id, versions: history })
  }))

  if (!candidates.length) return 0

  // LLM: classify each candidate as contradiction, update, or ambiguous
  const prompt = candidates.slice(0, 10).map(c =>
    `Memory ${c.id}:\n  Old: ${c.versions[0].content.slice(0, 200)}\n  New: ${c.versions[c.versions.length - 1].content.slice(0, 200)}`,
  ).join('\n\n')

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as BaseAiTextGenerationModels,
    { messages: [{ role: 'user', content:
      `Review these memory pairs where the observation changed. For each: determine if genuine contradiction, natural update, or ambiguous. Return JSON: {"results":[{"memory_id":"...","resolution":"genuine_contradiction"|"natural_update"|"ambiguous"}]}\n\n${prompt}` }] },
    { gateway: { id: 'brain-gateway' } },
  ) as { response?: string }

  let results: ContradictionResult[] = []
  try { results = JSON.parse(result.response ?? '{}').results ?? [] } catch { /* parse fail */ }

  // Write anomaly signals for contradictions
  let count = 0
  for (const r of results) {
    if (r.resolution === 'genuine_contradiction' || r.resolution === 'ambiguous') {
      const type = r.resolution === 'genuine_contradiction'
        ? 'memory.contradiction' : 'memory.contradiction_unresolved'
      await env.D1_US.prepare(
        `INSERT OR IGNORE INTO anomaly_signals
         (id, tenant_id, created_at, signal_type, severity, detail_json)
         VALUES (?, (SELECT tenant_id FROM consolidation_runs ORDER BY started_at DESC LIMIT 1), ?, ?, 'medium', ?)`,
      ).bind(crypto.randomUUID(), Date.now(), type, JSON.stringify({ memory_id: r.memory_id })).run()
      count++
    }
  }
  return count
}
