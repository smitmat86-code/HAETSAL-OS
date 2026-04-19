import type { CanonicalGraphProjectionDesignInput, CanonicalGraphProjectionPlan, CanonicalGraphProjectionStatus, GraphProjectionEdge, GraphProjectionEdgeReconciliation, GraphProjectionEntity, GraphProjectionEntityReconciliation, GraphProjectionEpisodeKind, GraphitiDeploymentPosture } from '../types/canonical-graph-projection'

const USER_LINE = /^User:/mi
const ASSISTANT_LINE = /^Assistant:/mi

export const GRAPHITI_DEPLOYMENT_POSTURE: GraphitiDeploymentPosture = {
  id: 'staged_external_first',
  initialRuntime: 'external_graphiti_service',
  orchestrationShell: 'cloudflare_worker_queue_shell',
  futureRuntime: 'cloudflare_containers',
  rationale: 'Start with an external Graphiti runtime behind the canonical queue shell, then move in-container once the projection contract and operational profile are proven.',
}

export const GRAPHITI_RECONCILIATION_RULES = {
  entity: {
    canonical_anchor: 'Reuse the same canonical key across captures.',
    stable_literal: 'Reuse the normalized literal within a tenant before creating a new entity.',
    content_extracted: 'Let Graphiti merge aliases later, but always keep canonical episode provenance.',
  },
  edge: {
    structural: 'Deduplicate by relation plus endpoints.',
    temporal: 'Append new observations by valid time instead of replacing prior relationship history.',
  },
} as const

function slugify(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return normalized || null
}

function classifyEpisodeKind(input: CanonicalGraphProjectionDesignInput): GraphProjectionEpisodeKind {
  if (input.artifactRef || input.sourceSystem === 'file') return 'artifact'
  return USER_LINE.test(input.body ?? '') && ASSISTANT_LINE.test(input.body ?? '') ? 'conversation' : 'note'
}

function pushEntity(list: GraphProjectionEntity[], entity: GraphProjectionEntity): void {
  if (!list.some(item => item.canonicalKey === entity.canonicalKey)) list.push(entity)
}

function pushEdge(list: GraphProjectionEdge[], edge: GraphProjectionEdge): void {
  if (!list.some(item => item.fromCanonicalKey === edge.fromCanonicalKey && item.toCanonicalKey === edge.toCanonicalKey && item.relation === edge.relation && item.validAt === edge.validAt)) list.push(edge)
}

export function buildCanonicalGraphProjectionPlan(input: CanonicalGraphProjectionDesignInput): CanonicalGraphProjectionPlan {
  const episodeKind = classifyEpisodeKind(input)
  const episodeKey = `canonical://captures/${input.captureId}`
  const scopeKey = `canonical://scopes/${input.scope}`
  const sourceKey = `canonical://sources/${input.sourceSystem}/${input.sourceRef?.trim() || input.captureId}`
  const entities: GraphProjectionEntity[] = []
  const edges: GraphProjectionEdge[] = []
  pushEntity(entities, { canonicalKey: scopeKey, kind: 'scope', label: input.scope, identityStrategy: 'canonical_anchor', source: 'metadata_anchor' })
  pushEntity(entities, { canonicalKey: sourceKey, kind: 'source', label: input.sourceRef?.trim() || input.sourceSystem, identityStrategy: 'canonical_anchor', source: 'metadata_anchor' })
  pushEdge(edges, { fromCanonicalKey: episodeKey, toCanonicalKey: scopeKey, relation: 'within_scope', temporalMode: 'snapshot', validAt: input.capturedAt ?? null })
  pushEdge(edges, { fromCanonicalKey: episodeKey, toCanonicalKey: sourceKey, relation: 'captured_via', temporalMode: 'snapshot', validAt: input.capturedAt ?? null })

  const topicSlug = slugify(input.title)
  if (topicSlug) {
    const topicKey = `canonical://topics/${topicSlug}`
    pushEntity(entities, { canonicalKey: topicKey, kind: 'topic', label: input.title!.trim(), identityStrategy: 'stable_literal', source: 'metadata_anchor' })
    pushEdge(edges, { fromCanonicalKey: episodeKey, toCanonicalKey: topicKey, relation: 'about_topic', temporalMode: 'snapshot', validAt: input.capturedAt ?? null })
  }
  if (episodeKind === 'conversation') {
    const userKey = 'canonical://participants/user'
    const assistantKey = 'canonical://participants/assistant'
    pushEntity(entities, { canonicalKey: userKey, kind: 'speaker', label: 'User', identityStrategy: 'stable_literal', source: 'metadata_anchor' })
    pushEntity(entities, { canonicalKey: assistantKey, kind: 'speaker', label: 'Assistant', identityStrategy: 'stable_literal', source: 'metadata_anchor' })
    pushEdge(edges, { fromCanonicalKey: episodeKey, toCanonicalKey: userKey, relation: 'has_participant', temporalMode: 'append_valid_time', validAt: input.capturedAt ?? null })
    pushEdge(edges, { fromCanonicalKey: episodeKey, toCanonicalKey: assistantKey, relation: 'has_participant', temporalMode: 'append_valid_time', validAt: input.capturedAt ?? null })
    pushEdge(edges, { fromCanonicalKey: userKey, toCanonicalKey: assistantKey, relation: 'conversed_with', temporalMode: 'append_valid_time', validAt: input.capturedAt ?? null })
  }
  if (episodeKind === 'artifact') {
    const documentKey = `canonical://documents/${input.documentId}`
    pushEntity(entities, { canonicalKey: documentKey, kind: 'document', label: input.title?.trim() || input.documentId, identityStrategy: 'canonical_anchor', source: 'metadata_anchor' })
    pushEdge(edges, { fromCanonicalKey: episodeKey, toCanonicalKey: documentKey, relation: 'describes_document', temporalMode: 'snapshot', validAt: input.capturedAt ?? null })
    if (input.artifactRef?.filename) {
      const artifactKey = `${documentKey}#artifact`
      pushEntity(entities, { canonicalKey: artifactKey, kind: 'artifact', label: input.artifactRef.filename, identityStrategy: 'canonical_anchor', source: 'metadata_anchor' })
      pushEdge(edges, { fromCanonicalKey: documentKey, toCanonicalKey: artifactKey, relation: 'backed_by_artifact', temporalMode: 'snapshot', validAt: input.capturedAt ?? null })
    }
  }
  return {
    posture: GRAPHITI_DEPLOYMENT_POSTURE,
    input: { tenantId: input.tenantId, captureId: input.captureId, documentId: input.documentId, operationId: input.operationId, scope: input.scope, sourceSystem: input.sourceSystem, sourceRef: input.sourceRef ?? null },
    episode: { canonicalCaptureId: input.captureId, canonicalDocumentId: input.documentId, canonicalOperationId: input.operationId, kind: episodeKind, canonicalKey: episodeKey, title: input.title?.trim() || null, validAt: input.capturedAt ?? null },
    entities,
    edges,
    extraction: { bodyAccess: 'trusted_runtime_only', storesRawContentInOperationalMetadata: false, requiresEntityExtraction: Boolean(input.body?.trim()) },
  }
}

export function reconcileGraphEntity(existing: GraphProjectionEntity | null, incoming: GraphProjectionEntity): GraphProjectionEntityReconciliation {
  return existing?.canonicalKey === incoming.canonicalKey
    ? { action: 'reuse', canonicalKey: incoming.canonicalKey, reason: GRAPHITI_RECONCILIATION_RULES.entity[incoming.identityStrategy] }
    : { action: 'create', canonicalKey: incoming.canonicalKey, reason: 'No matching canonical entity anchor exists yet.' }
}

export function reconcileGraphEdge(existing: GraphProjectionEdge | null, incoming: GraphProjectionEdge): GraphProjectionEdgeReconciliation {
  if (!existing) return { action: 'create', relation: incoming.relation, reason: 'No matching canonical edge exists yet.' }
  if (existing.fromCanonicalKey !== incoming.fromCanonicalKey || existing.toCanonicalKey !== incoming.toCanonicalKey || existing.relation !== incoming.relation) {
    return { action: 'create', relation: incoming.relation, reason: 'Relation or endpoint identity changed.' }
  }
  return incoming.temporalMode === 'append_valid_time'
    ? { action: 'append_observation', relation: incoming.relation, reason: GRAPHITI_RECONCILIATION_RULES.edge.temporal }
    : { action: 'dedupe', relation: incoming.relation, reason: GRAPHITI_RECONCILIATION_RULES.edge.structural }
}

export function buildCanonicalGraphProjectionStatus(row: { jobId: string; kind: string; status: string; resultStatus: string | null; targetRef: string | null; errorMessage: string | null; projectionResultId: string | null; updatedAt: number | null } | null): CanonicalGraphProjectionStatus | null {
  if (!row || row.kind !== 'graphiti') return null
  const status = row.resultStatus === 'failed' || row.status === 'failed'
    ? 'failed'
    : row.resultStatus === 'completed' || row.status === 'completed'
      ? 'projected'
      : row.resultStatus === 'queued' || row.status === 'queued'
        ? 'queued'
        : 'pending'
  return { mode: 'graphiti', status, ready: status === 'projected', jobId: row.jobId, projectionResultId: row.projectionResultId, targetRef: row.targetRef, errorMessage: row.errorMessage, updatedAt: row.updatedAt, reconciliationMode: 'episode_entity_edge_projection' }
}
