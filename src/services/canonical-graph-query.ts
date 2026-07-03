// Postgres-native graph traversal over canonical entities/edges — the only
// graph path post-Graphiti (HAETSAL_MISSION.md Phase 2). One-hop matching plus
// two-hop expansion; provenance cites the canonical capture that observed the
// edge, never a projection engine.

import type { Env } from '../types/env'
import type { CanonicalGraphEntityRef, CanonicalProjectionProvenance, EntityTimelineInput, EntityTimelineResult, TraceRelationshipInput, TraceRelationshipResult } from '../types/canonical-graph-query'
import { clampCanonicalLimit } from './canonical-memory-read-model'
import { getCanonicalGovernanceStore } from './canonical-governance-postgres'
import type { CanonicalEdgeWithEntities } from './canonical-governance-store'

const EDGE_SCAN_LIMIT = 500

function entityKey(kind: string, normalizedName: string): string {
  return `${kind}:${normalizedName}`
}

function entityRef(kind: string, name: string, normalizedName: string): CanonicalGraphEntityRef {
  return { key: entityKey(kind, normalizedName), label: name }
}

function matchesEntity(query: string, name: string, normalizedName: string, aliasesJson: string | null): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return false
  return normalizedName.includes(needle)
    || name.toLowerCase().includes(needle)
    || (aliasesJson ?? '').toLowerCase().includes(needle)
}

function provenanceOf(edge: CanonicalEdgeWithEntities): CanonicalProjectionProvenance {
  return {
    projectionKind: 'canonical',
    captureId: edge.capture_id,
    documentId: null,
    canonicalOperationId: null,
    projectionJobId: null,
    projectionResultId: null,
    targetRef: edge.claim_id ? `claim:${edge.claim_id}` : null,
    sourceSystem: null,
    graphRef: `edge:${edge.id}`,
  }
}

function edgeAt(edge: CanonicalEdgeWithEntities): number | null {
  return edge.valid_from ?? edge.created_at ?? null
}

const matchesSrc = (query: string, edge: CanonicalEdgeWithEntities): boolean =>
  matchesEntity(query, edge.src_name, edge.src_normalized_name, edge.src_aliases_json)
const matchesDst = (query: string, edge: CanonicalEdgeWithEntities): boolean =>
  matchesEntity(query, edge.dst_name, edge.dst_normalized_name, edge.dst_aliases_json)

export async function traceCanonicalRelationship(input: TraceRelationshipInput, env: Env, tenantId: string): Promise<TraceRelationshipResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const requestedRelation = input.relation?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || null
  const edges = await getCanonicalGovernanceStore(env).listEdgesWithEntities(tenantId, EDGE_SCAN_LIMIT)
  const items = edges.flatMap((edge) => {
    if (requestedRelation && edge.edge_type !== requestedRelation) return []
    const direct = matchesSrc(input.from, edge) && (!input.to || matchesDst(input.to, edge))
    const reverse = matchesDst(input.from, edge) && (!input.to || matchesSrc(input.to, edge))
    if (!direct && !reverse) return []
    const from = direct
      ? entityRef(edge.src_kind, edge.src_name, edge.src_normalized_name)
      : entityRef(edge.dst_kind, edge.dst_name, edge.dst_normalized_name)
    const to = direct
      ? entityRef(edge.dst_kind, edge.dst_name, edge.dst_normalized_name)
      : entityRef(edge.src_kind, edge.src_name, edge.src_normalized_name)
    return [{
      from,
      to,
      relation: edge.edge_type,
      title: null,
      scope: null,
      sourceSystem: null,
      sourceRef: edge.capture_id,
      capturedAt: edgeAt(edge),
      provenance: provenanceOf(edge),
    }]
  }).sort((left, right) => (right.capturedAt ?? 0) - (left.capturedAt ?? 0) || left.relation.localeCompare(right.relation))
  return { from: input.from, to: input.to ?? null, relation: input.relation ?? null, items: items.slice(0, limit) }
}

export async function getCanonicalEntityTimeline(input: EntityTimelineInput, env: Env, tenantId: string): Promise<EntityTimelineResult> {
  const limit = clampCanonicalLimit(input.limit, 10, 20)
  const startAt = input.startAt ?? Number.MIN_SAFE_INTEGER
  const endAt = input.endAt ?? Number.MAX_SAFE_INTEGER
  const edges = await getCanonicalGovernanceStore(env).listEdgesWithEntities(tenantId, EDGE_SCAN_LIMIT)

  // One-hop: edges touching the entity directly.
  const oneHop = edges.flatMap((edge) => {
    const effectiveAt = edgeAt(edge) ?? 0
    if (effectiveAt < startAt || effectiveAt > endAt) return []
    const isSrc = matchesSrc(input.entity, edge)
    const isDst = !isSrc && matchesDst(input.entity, edge)
    if (!isSrc && !isDst) return []
    const entity = isSrc
      ? entityRef(edge.src_kind, edge.src_name, edge.src_normalized_name)
      : entityRef(edge.dst_kind, edge.dst_name, edge.dst_normalized_name)
    const related = isSrc
      ? entityRef(edge.dst_kind, edge.dst_name, edge.dst_normalized_name)
      : entityRef(edge.src_kind, edge.src_name, edge.src_normalized_name)
    return [{
      entity,
      relatedEntity: related,
      relation: edge.edge_type,
      title: null,
      scope: null,
      sourceSystem: null,
      sourceRef: edge.capture_id,
      capturedAt: edgeAt(edge),
      provenance: provenanceOf(edge),
    }]
  })

  // Two-hop: edges touching any one-hop neighbor, attributed to the neighbor.
  const neighborKeys = new Set(oneHop.map((item) => item.relatedEntity.key))
  const seenEdges = new Set(oneHop.map((item) => item.provenance.graphRef))
  const twoHop = edges.flatMap((edge) => {
    if (seenEdges.has(`edge:${edge.id}`)) return []
    const effectiveAt = edgeAt(edge) ?? 0
    if (effectiveAt < startAt || effectiveAt > endAt) return []
    const srcKey = entityKey(edge.src_kind, edge.src_normalized_name)
    const dstKey = entityKey(edge.dst_kind, edge.dst_normalized_name)
    const viaSrc = neighborKeys.has(srcKey)
    const viaDst = !viaSrc && neighborKeys.has(dstKey)
    if (!viaSrc && !viaDst) return []
    const entity = viaSrc
      ? entityRef(edge.src_kind, edge.src_name, edge.src_normalized_name)
      : entityRef(edge.dst_kind, edge.dst_name, edge.dst_normalized_name)
    const related = viaSrc
      ? entityRef(edge.dst_kind, edge.dst_name, edge.dst_normalized_name)
      : entityRef(edge.src_kind, edge.src_name, edge.src_normalized_name)
    return [{
      entity,
      relatedEntity: related,
      relation: edge.edge_type,
      title: null,
      scope: null,
      sourceSystem: null,
      sourceRef: edge.capture_id,
      capturedAt: edgeAt(edge),
      provenance: provenanceOf(edge),
    }]
  })

  const items = [...oneHop, ...twoHop]
    .sort((left, right) => (left.capturedAt ?? 0) - (right.capturedAt ?? 0) || left.relation.localeCompare(right.relation))
  return { entity: input.entity, entityKey: oneHop[0]?.entity.key ?? null, items: items.slice(0, limit) }
}
