import type { CanonicalGraphProjectionStatus } from './canonical-graph-projection'
import type { CanonicalProjectionProvenance } from './canonical-graph-query'

export type MemoryQueryMode = 'raw' | 'semantic' | 'graph' | 'composed'
export type MemoryQueryModePreference = MemoryQueryMode | 'lexical'

export interface CanonicalMemoryRouteDecision { mode: MemoryQueryMode; reason: string; explicit: boolean; dispatchQuery: string }
export interface CanonicalSourceAttribution {
  mode: MemoryQueryMode; sourceSystem: string | null; captureId: string | null; documentId: string | null
  canonicalOperationId: string | null; projectionKind: 'hindsight' | 'graphiti' | null
  projectionRef: string | null; targetRef: string | null; graphRef: string | null
}

export interface CanonicalSearchInput {
  tenantId: string
  query: string
  scope?: string | null
  limit?: number
  mode?: MemoryQueryModePreference
}

export interface CanonicalRecentInput { tenantId: string; scope?: string | null; limit?: number }
export interface CanonicalDocumentInput { tenantId: string; documentId: string }
export interface CanonicalMemoryStatusInput {
  tenantId: string
  captureId?: string
  operationId?: string
}

export interface CanonicalMemoryListItem {
  captureId: string | null
  documentId: string | null
  title: string | null
  scope: string | null
  sourceSystem: string | null
  sourceRef: string | null
  preview: string
  capturedAt: number | null
  score?: number | null
  mode?: MemoryQueryMode
  recallText?: string | null
  attribution?: CanonicalSourceAttribution | null
  provenance?: CanonicalProjectionProvenance | null
  semanticStatus?: {
    projectionKind: 'hindsight'
    projectionStatus: 'accepted' | 'queued' | 'completed' | 'failed' | 'unknown'
    resultStatus: 'queued' | 'completed' | 'failed' | 'missing'
    ready: boolean
  } | null
  graphContext?: {
    entityKey: string
    entityLabel: string
    relation?: string | null
    relatedEntityKey?: string | null
    relatedEntityLabel?: string | null
    graphRef?: string | null
    targetRef?: string | null
  } | null
}

export interface CanonicalSearchResult {
  query: string
  mode: MemoryQueryMode
  status: 'ok' | 'partial' | 'unavailable'
  route?: CanonicalMemoryRouteDecision | null
  items: CanonicalMemoryListItem[]
}

export interface CanonicalRecentResult { items: CanonicalMemoryListItem[] }
export interface CanonicalDocumentArtifact {
  artifactId: string
  filename: string | null
  mediaType: string | null
  byteLength: number | null
}

export interface CanonicalDocumentResult {
  captureId: string
  documentId: string
  title: string | null
  scope: string
  sourceSystem: string
  sourceRef: string | null
  body: string
  chunkCount: number
  capturedAt: number
  createdAt: number
  artifact: CanonicalDocumentArtifact | null
}

export interface CanonicalReflectionStatus {
  mode: 'hindsight'
  status: 'pending' | 'queued' | 'completed' | 'failed'
  targetRef?: string | null
  updatedAt?: number | null
  errorMessage?: string | null
}

export interface CanonicalMemoryStatusResult {
  captureId: string
  operation: {
    operationId: string
    operationType: string
    status: string
    createdAt: number
    updatedAt: number
  }
  projections: Array<{
    jobId: string
    documentId: string
    kind: string
    status: string
    resultStatus: string | null
    targetRef: string | null
    errorMessage: string | null
    projectionResultId: string | null
    engineDocumentId: string | null
    engineOperationId: string | null
    semanticReady: boolean
    updatedAt: number | null
  }>
  graph: CanonicalGraphProjectionStatus | null
  reflection: CanonicalReflectionStatus | null
  compatibility: {
    mode: 'current_hindsight'
    status: 'queued' | 'retained' | 'failed'
    targetRef: string | null
    errorMessage: string | null
    updatedAt: number | null
  } | null
}

export interface CanonicalMemoryStatsResult {
  captureCount: number
  documentCount: number
  chunkCount: number
  operationCount: number
  pendingProjectionCount: number
  completedProjectionCount: number
  failedProjectionCount: number
  lastCaptureAt: number | null
  scopes: Array<{ scope: string; count: number }>
}
