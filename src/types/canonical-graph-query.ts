export interface TraceRelationshipInput {
  tenantId: string
  from: string
  to?: string | null
  relation?: string | null
  limit?: number
}

export interface EntityTimelineInput {
  tenantId: string
  entity: string
  startAt?: number | null
  endAt?: number | null
  limit?: number
}

export interface CanonicalProjectionProvenance {
  projectionKind: 'hindsight' | 'graphiti'
  captureId?: string | null
  documentId?: string | null
  canonicalOperationId?: string | null
  projectionJobId?: string | null
  projectionResultId?: string | null
  targetRef?: string | null
  sourceSystem?: string | null
  graphRef?: string | null
}

export interface CanonicalGraphEntityRef { key: string; label: string }

export interface CanonicalGraphTraceItem {
  from: CanonicalGraphEntityRef
  to: CanonicalGraphEntityRef
  relation: string
  title: string | null
  scope: string | null
  sourceSystem: string | null
  sourceRef: string | null
  capturedAt: number | null
  provenance: CanonicalProjectionProvenance
}

export interface TraceRelationshipResult {
  from: string
  to: string | null
  relation: string | null
  items: CanonicalGraphTraceItem[]
}

export interface CanonicalGraphTimelineItem {
  entity: CanonicalGraphEntityRef
  relatedEntity: CanonicalGraphEntityRef
  relation: string
  title: string | null
  scope: string | null
  sourceSystem: string | null
  sourceRef: string | null
  capturedAt: number | null
  provenance: CanonicalProjectionProvenance
}

export interface EntityTimelineResult {
  entity: string
  entityKey: string | null
  items: CanonicalGraphTimelineItem[]
}
