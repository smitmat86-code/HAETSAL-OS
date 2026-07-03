// src/cron/passes/pass2-bridges.ts
// Bridge edge discovery — Hindsight graph retired in mission phase 3; seeds from canonical governance store.
// Uses getCanonicalGovernanceStore(env).listEdgesWithEntities() to build adjacency map.

import type { Env } from '../../types/env'
import type { IngestionArtifact } from '../../types/ingestion'
import { retainContent } from '../../services/ingestion/retain'
import { getCanonicalGovernanceStore } from '../../services/canonical-governance-postgres'

interface BridgeResult {
  memory_id_a: string
  memory_id_b: string
  insight: string
  domains: [string, string]
}

export async function runPass2(
  _bankId: string, tenantId: string, kek: CryptoKey, env: Env,
): Promise<number> {
  const edges = await getCanonicalGovernanceStore(env)
    .listEdgesWithEntities(tenantId, 200)
    .catch(() => [])

  if (!edges.length) return 0

  // Build adjacency map: entity_id -> Set<entity_id>
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    const src = edge.src_entity_id
    const dst = edge.dst_entity_id
    if (!adjacency.has(src)) adjacency.set(src, new Set())
    if (!adjacency.has(dst)) adjacency.set(dst, new Set())
    adjacency.get(src)!.add(dst)
    adjacency.get(dst)!.add(src)
  }

  // Collect unique entity ids with their kind as "domain"
  const entityKindMap = new Map<string, string>()
  for (const edge of edges) {
    entityKindMap.set(edge.src_entity_id, edge.src_kind)
    entityKindMap.set(edge.dst_entity_id, edge.dst_kind)
  }
  const entityIds = [...entityKindMap.keys()]

  const candidates: Array<{ a: string; b: string; shared: number; domains: [string, string] }> = []
  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const a = entityIds[i]
      const b = entityIds[j]
      const domainA = entityKindMap.get(a) ?? 'general'
      const domainB = entityKindMap.get(b) ?? 'general'
      if (domainA === domainB) continue
      if (adjacency.get(a)?.has(b)) continue

      const neighborsA = adjacency.get(a) ?? new Set()
      const neighborsB = adjacency.get(b) ?? new Set()
      const shared = [...neighborsA].filter(n => neighborsB.has(n)).length
      if (shared > 0) candidates.push({ a, b, shared, domains: [domainA, domainB] })
    }
  }

  candidates.sort((left, right) => right.shared - left.shared)
  const top = candidates.slice(0, 10)
  if (!top.length) return 0

  const prompt = top
    .map(c => `Pair: ${c.a} (${c.domains[0]}) <-> ${c.b} (${c.domains[1]}) - ${c.shared} shared neighbors`)
    .join('\n')

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    { messages: [{ role: 'user', content:
      `These entity pairs share indirect connections but no direct edge. Identify which reveal genuine cross-domain insight. Return JSON: {"bridges":[{"memory_id_a":"...","memory_id_b":"...","insight":"one sentence","domains":["...",".."]}]}. Max 5.\n\n${prompt}` }] },
    { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } },
  ) as { response?: string }

  let bridges: BridgeResult[] = []
  try { bridges = JSON.parse(result.response ?? '{}').bridges ?? [] } catch { /* parse fail */ }

  let count = 0
  for (const bridge of bridges.slice(0, 5)) {
    const artifact: IngestionArtifact = {
      tenantId,
      content: bridge.insight,
      source: 'cron:consolidation',
      memoryType: 'semantic',
      domain: 'general',
      provenance: 'pass2_bridge',
      occurredAt: Date.now(),
      metadata: { is_bridge: true, bridge_memory_ids: [bridge.memory_id_a, bridge.memory_id_b] },
    }
    await retainContent(artifact, kek, env).catch(() => {})
    count++
  }

  return count
}
