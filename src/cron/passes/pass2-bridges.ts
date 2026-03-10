// src/cron/passes/pass2-bridges.ts
// Bridge edge discovery — seeded from Hindsight /graph (structural, no decrypt)
// Only decrypts candidate pair content for LLM insight generation

import type { Env } from '../../types/env'
import type { IngestionArtifact } from '../../types/ingestion'
import { retainContent } from '../../services/ingestion/retain'

interface GraphNode { id: string; tags?: string[] }
interface GraphEdge { source: string; target: string }
interface BridgeResult {
  memory_id_a: string; memory_id_b: string
  insight: string; domains: [string, string]
}

export async function runPass2(
  bankId: string, tenantId: string, kek: CryptoKey, env: Env,
): Promise<number> {
  const graphRes = await env.HINDSIGHT.fetch(
    `http://hindsight/v1/default/banks/${bankId}/graph?limit=200`,
  )
  if (!graphRes.ok) return 0
  const { nodes, edges } = await graphRes.json() as { nodes: GraphNode[]; edges: GraphEdge[] }
  if (!nodes?.length || !edges?.length) return 0

  // Build adjacency and find structural holes (cross-domain pairs sharing neighbors)
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set())
    if (!adj.has(e.target)) adj.set(e.target, new Set())
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
  }

  const domainOf = (n: GraphNode) => n.tags?.find(t => t.startsWith('domain:'))?.slice(7) ?? 'general'
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const candidates: Array<{ a: string; b: string; shared: number; domains: [string, string] }> = []

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      if (domainOf(a) === domainOf(b)) continue
      if (adj.get(a.id)?.has(b.id)) continue // already connected
      const neighborsA = adj.get(a.id) ?? new Set()
      const neighborsB = adj.get(b.id) ?? new Set()
      const shared = [...neighborsA].filter(n => neighborsB.has(n)).length
      if (shared > 0) candidates.push({ a: a.id, b: b.id, shared, domains: [domainOf(a), domainOf(b)] })
    }
  }

  candidates.sort((x, y) => y.shared - x.shared)
  const top = candidates.slice(0, 10)
  if (!top.length) return 0

  // LLM: identify genuine cross-domain insights
  const prompt = top.map(c => `Pair: ${c.a} (${c.domains[0]}) ↔ ${c.b} (${c.domains[1]}) — ${c.shared} shared neighbors`).join('\n')
  const result = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as BaseAiTextGenerationModels,
    { messages: [{ role: 'user', content:
      `These memory pairs share indirect connections but no direct edge. Identify which reveal genuine cross-domain insight. Return JSON: {"bridges":[{"memory_id_a":"...","memory_id_b":"...","insight":"one sentence","domains":["...",".."]}]}. Max 5.\n\n${prompt}` }] },
    { gateway: { id: 'brain-gateway' } },
  ) as { response?: string }

  let bridges: BridgeResult[] = []
  try { bridges = JSON.parse(result.response ?? '{}').bridges ?? [] } catch { /* parse fail */ }

  // Retain bridges as semantic with is_bridge metadata
  let count = 0
  for (const b of bridges.slice(0, 5)) {
    const artifact: IngestionArtifact = {
      tenantId, content: b.insight, source: 'cron:consolidation',
      memoryType: 'semantic', domain: 'general', provenance: 'pass2_bridge',
      occurredAt: Date.now(),
      metadata: { is_bridge: true, bridge_memory_ids: [b.memory_id_a, b.memory_id_b] },
    }
    await retainContent(artifact, kek, env).catch(() => {})
    count++
  }
  return count
}
