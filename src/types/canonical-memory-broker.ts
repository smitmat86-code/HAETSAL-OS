import type {
  CanonicalMemoryRouteDecision,
  CanonicalMemoryRouteMetadata,
  CanonicalSearchResult,
  MemoryQueryMode,
  MemoryQueryModePreference,
} from './canonical-memory-query'

export type CanonicalBrokerBranchStatus =
  | 'ok'
  | 'partial'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'skipped'
  | 'unavailable'

export type CanonicalBrokerOverlap = 'same' | 'partial' | 'distinct' | 'unknown'

export interface CanonicalBrokerBranchTrace {
  mode: MemoryQueryMode | null
  status: CanonicalBrokerBranchStatus
  latencyMs: number | null
  itemCount: number
  summary: string | null
  projectionKind: 'hindsight' | 'graphiti' | 'canonical' | 'mixed' | null
  projectionRef: string | null
  captureId: string | null
  errorMessage: string | null
}

export interface CanonicalBrokerTraceDetail {
  queryId: string
  tenantId: string
  queryText: string
  requestedMode: MemoryQueryModePreference | null
  route: CanonicalMemoryRouteDecision
  primary: CanonicalBrokerBranchTrace
  shadow: CanonicalBrokerBranchTrace
  overlap: CanonicalBrokerOverlap
  surfaced: {
    mode: MemoryQueryMode
    status: CanonicalSearchResult['status']
    summary: string | null
    itemCount: number
  }
  createdAt: number
}

export interface CanonicalBrokeredSearchResult {
  result: CanonicalSearchResult
  broker: CanonicalMemoryRouteMetadata
}
