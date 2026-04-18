// src/cron/passes/pass2-bridges.ts
// Bridge edge discovery seeds from Hindsight graph structure, then retains cross-domain insights.

import type { Env } from '../../types/env'
import type { IngestionArtifact } from '../../types/ingestion'
import { retainContent } from '../../services/ingestion/retain'
import { fetchGraph } from '../../services/hindsight'

interface GraphNode { id: string; tags?: string[] }
interface GraphEdge { source: string; target: string }
interface BridgeResult {
  memory_id_a: string
  memory_id_b: string
  insight: string
  domains: [string, string]
}

export async function runPass2(
  bankId: string, tenantId: string, kek: CryptoKey, env: Env,
): Promise<number> {
  const graph = await fetchGraph<GraphNode, GraphEdge>(bankId, 200, env)
  if (!graph?.nodes?.length || !graph.edges?.length) return 0

  const { nodes, edges } = graph

  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set())
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
    adjacency.get(edge.source)!.add(edge.target)
    adjacency.get(edge.target)!.add(edge.source)
  }

  const domainOf = (node: GraphNode) => node.tags?.find(tag => tag.startsWith('domain:'))?.slice(7) ?? 'general'
  const candidates: Array<{ a: string; b: string; shared: number; domains: [string, string] }> = []

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      if (domainOf(a) === domainOf(b)) continue
      if (adjacency.get(a.id)?.has(b.id)) continue

      const neighborsA = adjacency.get(a.id) ?? new Set()
      const neighborsB = adjacency.get(b.id) ?? new Set()
      const shared = [...neighborsA].filter(neighbor => neighborsB.has(neighbor)).length
      if (shared > 0) candidates.push({ a: a.id, b: b.id, shared, domains: [domainOf(a), domainOf(b)] })
    }
  }

  candidates.sort((left, right) => right.shared - left.shared)
  const top = candidates.slice(0, 10)
  if (!top.length) return 0

  const prompt = top
    .map(candidate => `Pair: ${candidate.a} (${candidate.domains[0]}) <-> ${candidate.b} (${candidate.domains[1]}) - ${candidate.shared} shared neighbors`)
    .join('\n')

  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    { messages: [{ role: 'user', content:
      `These memory pairs share indirect connections but no direct edge. Identify which reveal genuine cross-domain insight. Return JSON: {"bridges":[{"memory_id_a":"...","memory_id_b":"...","insight":"one sentence","domains":["...",".."]}]}. Max 5.\n\n${prompt}` }] },
    { gateway: { id: env.AI_GATEWAY_ID } },
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
