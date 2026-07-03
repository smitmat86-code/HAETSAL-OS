import type {
  MemoryQueryMode,
  MemoryQueryModePreference,
} from './canonical-memory-query'
import type { CanonicalMemoryRouteMetadata, CanonicalSearchResult } from './canonical-memory-query'

export type CanonicalBrokerBranchStatus =
  | 'ok'
  | 'partial'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'skipped'
  | 'unavailable'

export type CanonicalBrokerOverlap = 'same' | 'partial' | 'distinct' | 'unknown'
export type CanonicalBrokerDetailStatus = 'ok' | 'missing' | 'undecryptable'

export interface CanonicalBrokerRouteTrace {
  mode: MemoryQueryMode
  reason: string
  explicit: boolean
  dispatchQuery: string | null
}

export interface CanonicalBrokerBranchTrace {
  mode: MemoryQueryMode | null
  status: CanonicalBrokerBranchStatus
  latencyMs: number | null
  itemCount: number | null
  summary: string | null
  projectionKind: string | null
  projectionRef: string | null
  captureId: string | null
  errorMessage: string | null
}

export interface CanonicalBrokerTraceDetail {
  queryId: string
  tenantId: string
  queryText: string
  requestedMode: MemoryQueryModePreference | null
  route: CanonicalBrokerRouteTrace
  primary: CanonicalBrokerBranchTrace
  shadow: CanonicalBrokerBranchTrace
  overlap: CanonicalBrokerOverlap
  surfaced: {
    mode: MemoryQueryMode
    status: CanonicalSearchResult['status']
    summary: string | null
    itemCount: number | null
  }
  createdAt: number
}

export interface CanonicalBrokeredSearchResult {
  result: CanonicalSearchResult
  broker: CanonicalMemoryRouteMetadata
}

export interface CanonicalBrokerTraceListInput {
  tenantId: string
  limit?: number
  mode?: MemoryQueryMode | null
}

export interface CanonicalBrokerTraceInput {
  tenantId: string
  queryId: string
}

export interface CanonicalBrokerTraceListItem {
  queryId: string
  createdAt: number
  requestedMode: MemoryQueryModePreference | null
  primaryMode: MemoryQueryMode
  shadowMode: MemoryQueryMode | null
  primaryStatus: CanonicalBrokerBranchStatus
  shadowStatus: CanonicalBrokerBranchStatus
  overlap: CanonicalBrokerOverlap
  surfacedSummary: string | null
  detailStatus: CanonicalBrokerDetailStatus
}

export interface CanonicalBrokerTraceListResult {
  items: CanonicalBrokerTraceListItem[]
}

export interface CanonicalBrokerTraceView {
  queryId: string
  createdAt: number
  queryText: string | null
  requestedMode: MemoryQueryModePreference | null
  route: CanonicalBrokerRouteTrace
  primary: CanonicalBrokerBranchTrace
  shadow: CanonicalBrokerBranchTrace
  surfaced: {
    mode: MemoryQueryMode
    status: CanonicalSearchResult['status']
    summary: string | null
    itemCount: number | null
  }
  overlap: CanonicalBrokerOverlap
  detailStatus: CanonicalBrokerDetailStatus
}
