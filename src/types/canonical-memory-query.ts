import type { CanonicalProjectionProvenance } from './canonical-graph-query'
import type { BrainMemoryRolloutAttribution } from './external-client-memory'
import type { GoogleSourceReadAttribution } from './google-source-read'

/** The seven retrieval broker modes (HAETSAL_MISSION.md Phase 2). */
export type MemoryQueryMode = 'raw' | 'lexical' | 'semantic' | 'graph' | 'temporal' | 'compiled' | 'composed'
export type MemoryQueryModePreference = MemoryQueryMode

/** Evidence contract attached to every retrieval result item (Phase 2). */
export interface CanonicalRetrievalCitation {
  captureId: string | null
  documentId: string | null
  chunkId: string | null
  sourceSystem: string | null
  sourceRef: string | null
  capturedAt: number | null
  trustState: string | null
  usePolicy: string | null
  memoryClass: string | null
  authorKind: string | null
}

export interface CanonicalMemoryRouteDecision { mode: MemoryQueryMode; reason: string; explicit: boolean; dispatchQuery: string }
export interface CanonicalMemoryRouteMetadata {
  queryId: string
  primaryMode: MemoryQueryMode
  shadowMode: MemoryQueryMode | null
  shadowDispatch: 'scheduled' | 'skipped'
}
export interface CanonicalSourceAttribution {
  mode: MemoryQueryMode; sourceSystem: string | null; captureId: string | null; documentId: string | null
  canonicalOperationId: string | null; projectionKind: string | null
  projectionRef: string | null; targetRef: string | null; graphRef: string | null
}

export interface CanonicalSearchInput { tenantId: string; query: string; scope?: string | null; limit?: number; mode?: MemoryQueryModePreference }
export interface CanonicalRecentInput { tenantId: string; scope?: string | null; limit?: number }
export interface CanonicalDocumentInput { tenantId: string; documentId: string }
export interface CanonicalMemoryStatusInput { tenantId: string; captureId?: string; operationId?: string }

export interface CanonicalMemoryListItem {
  captureId: string | null; documentId: string | null; title: string | null; scope: string | null
  sourceSystem: string | null; sourceRef: string | null; preview: string; capturedAt: number | null
  score?: number | null; mode?: MemoryQueryMode; brainMemory?: BrainMemoryRolloutAttribution | null
  googleSource?: GoogleSourceReadAttribution | null
  recallText?: string | null; attribution?: CanonicalSourceAttribution | null; provenance?: CanonicalProjectionProvenance | null
  citation?: CanonicalRetrievalCitation | null
  trustState?: string | null
  semanticStatus?: {
    projectionKind: string
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
  broker?: CanonicalMemoryRouteMetadata | null
  items: CanonicalMemoryListItem[]
}
export interface CanonicalRecentResult { items: CanonicalMemoryListItem[] }
export interface CanonicalDocumentArtifact { artifactId: string; filename: string | null; mediaType: string | null; byteLength: number | null; storageKind?: string | null; storageKey?: string | null }
export interface CanonicalDocumentResult {
  captureId: string; documentId: string; title: string | null; scope: string; sourceSystem: string; sourceRef: string | null
  brainMemory?: BrainMemoryRolloutAttribution | null; googleSource?: GoogleSourceReadAttribution | null
  body: string; chunkCount: number; capturedAt: number; createdAt: number
  artifact: CanonicalDocumentArtifact | null
}

/** Retired in mission Phase 3 — both engine projection statuses are null after cleanup. */
export interface CanonicalReflectionStatus { mode: string; status: 'pending' | 'queued' | 'completed' | 'failed'; targetRef?: string | null; updatedAt?: number | null; errorMessage?: string | null }
export interface CanonicalMemoryStatusResult {
  captureId: string; sourceSystem?: string | null; sourceRef?: string | null; scope?: string | null
  title?: string | null; capturedAt?: number | null; brainMemory?: BrainMemoryRolloutAttribution | null
  googleSource?: GoogleSourceReadAttribution | null
  operation: { operationId: string; operationType: string; status: string; createdAt: number; updatedAt: number }
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
  graph: null
  reflection: CanonicalReflectionStatus | null
  compatibility: null
}

export interface CanonicalMemoryStatsResult {
  captureCount: number; documentCount: number; chunkCount: number; operationCount: number
  pendingProjectionCount: number; completedProjectionCount: number; failedProjectionCount: number
  lastCaptureAt: number | null; scopes: Array<{ scope: string; count: number }>
}
