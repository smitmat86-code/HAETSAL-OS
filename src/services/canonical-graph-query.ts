import type { Env } from '../types/env'
import type { CanonicalGraphEntityRef, CanonicalProjectionProvenance, EntityTimelineInput, EntityTimelineResult, TraceRelationshipInput, TraceRelationshipResult } from '../types/canonical-graph-query'
import { clampCanonicalLimit } from './canonical-memory-read-model'
import { labelCanonicalGraphEntity, matchesCanonicalGraphEntity, parseCanonicalGraphEdgeKey } from './canonical-graph-query-helpers'

interface EdgeRow { canonical_key: string; graph_ref: string; projection_job_id: string; projection_result_id: string | null; target_ref: string | null; operation_id: string; capture_id: string; document_id: string; scope: string; source_system: string; source_ref: string | null; title: string | null; captured_at: number | null }
interface EdgeObservation extends EdgeRow { fromKey: string; toKey: string; relation: string; eventAt: number | null }

function toProvenance(row: EdgeRow): CanonicalProjectionProvenance {
  return { projectionKind: 'graphiti', captureId: row.capture_id, documentId: row.document_id, canonicalOperationId: row.operation_id, projectionJobId: row.projection_job_id, projectionResultId: row.projection_result_id, targetRef: row.target_ref, sourceSystem: row.source_system, graphRef: row.graph_ref }
}

async function listEdgeObservations(env: Env, tenantId: string): Promise<EdgeObservation[]> {
  const rows = await env.D1_US.prepare(
    `SELECT m.canonical_key, m.graph_ref, j.id AS projection_job_id, j.operation_id, j.document_id,
            c.id AS capture_id, c.scope, c.source_system, c.source_ref, c.title, c.captured_at,
            r.id AS projection_result_id, r.target_ref
     FROM canonical_graph_identity_mappings m
     INNER JOIN canonical_projection_jobs j ON j.id = m.projection_job_id
     INNER JOIN canonical_captures c ON c.id = j.capture_id
     LEFT JOIN canonical_projection_results r ON r.id = (
       SELECT r2.id FROM canonical_projection_results r2
       WHERE r2.projection_job_id = j.id
       ORDER BY r2.updated_at DESC, r2.created_at DESC, r2.id DESC LIMIT 1
     )
     WHERE m.tenant_id = ? AND m.graph_kind = 'edge'
       AND j.projection_kind = 'graphiti' AND j.status = 'completed'`,
  ).bind(tenantId).all<EdgeRow>()
  return (rows.results ?? []).flatMap(row => {
    const parsed = parseCanonicalGraphEdgeKey(row.canonical_key)
    return parsed ? [{ ...row, ...parsed }] : []
  })
}

const asEntity = (key: string, row: EdgeRow): CanonicalGraphEntityRef => ({ key, label: labelCanonicalGraphEntity(key, row) })

export async function traceCanonicalRelationship(input: TraceRelationshipInput, env: Env, tenantId: string): Promise<TraceRelationshipResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const requestedRelation = input.relation?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || null
  const items = (await listEdgeObservations(env, tenantId)).flatMap(row => {
    if (requestedRelation && row.relation !== requestedRelation) return []
    const direct = matchesCanonicalGraphEntity(input.from, row.fromKey, row) && (!input.to || matchesCanonicalGraphEntity(input.to, row.toKey, row))
    const reverse = matchesCanonicalGraphEntity(input.from, row.toKey, row) && (!input.to || matchesCanonicalGraphEntity(input.to, row.fromKey, row))
    if (!direct && !reverse) return []
    const fromKey = direct ? row.fromKey : row.toKey
    const toKey = direct ? row.toKey : row.fromKey
    return [{ from: asEntity(fromKey, row), to: asEntity(toKey, row), relation: row.relation, title: row.title, scope: row.scope, sourceSystem: row.source_system, sourceRef: row.source_ref, capturedAt: row.eventAt ?? row.captured_at, provenance: toProvenance(row) }]
  }).sort((left, right) => (right.capturedAt ?? 0) - (left.capturedAt ?? 0) || left.relation.localeCompare(right.relation))
  return { from: input.from, to: input.to ?? null, relation: input.relation ?? null, items: items.slice(0, limit) }
}

export async function getCanonicalEntityTimeline(input: EntityTimelineInput, env: Env, tenantId: string): Promise<EntityTimelineResult> {
  const limit = clampCanonicalLimit(input.limit, 10, 20)
  const startAt = input.startAt ?? Number.MIN_SAFE_INTEGER
  const endAt = input.endAt ?? Number.MAX_SAFE_INTEGER
  const items = (await listEdgeObservations(env, tenantId)).flatMap(row => {
    const effectiveAt = row.eventAt ?? row.captured_at ?? 0
    if (effectiveAt < startAt || effectiveAt > endAt) return []
    const entityKey = matchesCanonicalGraphEntity(input.entity, row.fromKey, row) ? row.fromKey : matchesCanonicalGraphEntity(input.entity, row.toKey, row) ? row.toKey : null
    if (!entityKey) return []
    const relatedKey = entityKey === row.fromKey ? row.toKey : row.fromKey
    return [{ entity: asEntity(entityKey, row), relatedEntity: asEntity(relatedKey, row), relation: row.relation, title: row.title, scope: row.scope, sourceSystem: row.source_system, sourceRef: row.source_ref, capturedAt: row.eventAt ?? row.captured_at, provenance: toProvenance(row) }]
  }).sort((left, right) => (left.capturedAt ?? 0) - (right.capturedAt ?? 0) || left.relation.localeCompare(right.relation))
  return { entity: input.entity, entityKey: items[0]?.entity.key ?? null, items: items.slice(0, limit) }
}
