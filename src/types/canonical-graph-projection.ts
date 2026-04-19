import type { CanonicalArtifactRef } from './canonical-memory'

export type GraphitiDeploymentPostureId = 'staged_external_first'
export type GraphProjectionEpisodeKind = 'note' | 'conversation' | 'artifact' | 'event'
export type GraphProjectionEntityKind =
  | 'scope'
  | 'source'
  | 'speaker'
  | 'topic'
  | 'document'
  | 'artifact'
export type GraphProjectionIdentityStrategy =
  | 'canonical_anchor'
  | 'stable_literal'
  | 'content_extracted'
export type GraphProjectionTemporalMode = 'snapshot' | 'append_valid_time'

export interface GraphitiDeploymentPosture {
  id: GraphitiDeploymentPostureId
  initialRuntime: 'external_graphiti_service'
  orchestrationShell: 'cloudflare_worker_queue_shell'
  futureRuntime: 'cloudflare_containers'
  rationale: string
}

export interface CanonicalGraphProjectionInput {
  tenantId: string
  captureId: string
  documentId: string
  operationId: string
  scope: string
  sourceSystem: string
  sourceRef?: string | null
}

export interface CanonicalGraphProjectionDesignInput extends CanonicalGraphProjectionInput {
  title?: string | null
  body?: string | null
  capturedAt?: number | null
  artifactRef?: CanonicalArtifactRef | null
}

export interface GraphProjectionEpisode {
  canonicalCaptureId: string
  canonicalDocumentId: string
  canonicalOperationId: string
  kind: GraphProjectionEpisodeKind
  canonicalKey: string
  title: string | null
  validAt: number | null
}

export interface GraphProjectionEntity {
  canonicalKey: string
  kind: GraphProjectionEntityKind
  label: string
  graphEntityRef?: string | null
  identityStrategy: GraphProjectionIdentityStrategy
  source: 'metadata_anchor' | 'content_candidate'
}

export interface GraphProjectionEdge {
  canonicalKey: string
  fromCanonicalKey: string
  toCanonicalKey: string
  relation: string
  graphEdgeRef?: string | null
  temporalMode: GraphProjectionTemporalMode
  validAt: number | null
}

export interface CanonicalGraphProjectionExtractionPlan {
  bodyAccess: 'trusted_runtime_only'
  storesRawContentInOperationalMetadata: false
  requiresEntityExtraction: boolean
}

export interface CanonicalGraphProjectionPlan {
  posture: GraphitiDeploymentPosture
  input: CanonicalGraphProjectionInput
  episode: GraphProjectionEpisode
  entities: GraphProjectionEntity[]
  edges: GraphProjectionEdge[]
  extraction: CanonicalGraphProjectionExtractionPlan
}

export interface GraphProjectionEntityReconciliation {
  action: 'reuse' | 'create'
  canonicalKey: string
  reason: string
}

export interface GraphProjectionEdgeReconciliation {
  action: 'dedupe' | 'append_observation' | 'create'
  relation: string
  reason: string
}

export interface CanonicalGraphProjectionStatus {
  mode: 'graphiti'
  status: 'pending' | 'queued' | 'projected' | 'failed'
  ready: boolean
  jobId: string | null
  projectionResultId: string | null
  targetRef: string | null
  errorMessage: string | null
  updatedAt: number | null
  reconciliationMode: 'episode_entity_edge_projection'
}

export type CanonicalGraphIdentityKind = 'episode' | 'entity' | 'edge'

export interface CanonicalGraphIdentityMapping {
  canonicalKey: string
  graphRef: string
  graphKind: CanonicalGraphIdentityKind
}

export interface GraphitiProjectionDispatchInput {
  tenantId: string
  captureId: string
  operationId: string
  projectionJobId: string
  projectionKind: 'graphiti'
}

export interface GraphitiProjectionSubmissionResult {
  targetRef: string
  status: 'queued' | 'completed'
  operationRef?: string | null
  episodeRefs?: string[]
  entityRefs?: string[]
  edgeRefs?: string[]
  mappings: CanonicalGraphIdentityMapping[]
}
