import type { Env } from '../types/env'
import type {
  CanonicalBrokerBranchStatus,
  CanonicalBrokerBranchTrace,
  CanonicalBrokerDetailStatus,
  CanonicalBrokerOverlap,
  CanonicalBrokerTraceDetail,
  CanonicalBrokerTraceListItem,
  CanonicalBrokerTraceView,
  CanonicalBrokerRouteTrace,
} from '../types/canonical-memory-broker'
import type {
  CanonicalSearchResult,
  MemoryQueryMode,
  MemoryQueryModePreference,
} from '../types/canonical-memory-query'
import { sha256Hex } from './canonical-memory-artifacts'
import { decryptCanonicalPayload, type CanonicalMemoryReadOptions } from './canonical-memory-read-model'

export interface CanonicalBrokerTraceRow {
  id: string
  tenant_id: string
  requested_mode: MemoryQueryModePreference | null
  primary_mode: MemoryQueryMode
  primary_reason: string
  primary_explicit: number
  primary_status: CanonicalBrokerBranchStatus
  primary_latency_ms: number | null
  primary_projection_kind: CanonicalBrokerBranchTrace['projectionKind']
  primary_projection_ref: string | null
  primary_capture_id: string | null
  shadow_mode: MemoryQueryMode | null
  shadow_status: CanonicalBrokerBranchStatus
  shadow_latency_ms: number | null
  shadow_projection_kind: CanonicalBrokerBranchTrace['projectionKind']
  shadow_projection_ref: string | null
  shadow_capture_id: string | null
  overlap: CanonicalBrokerOverlap
  detail_r2_key: string | null
  detail_sha256: string | null
  created_at: number
}

export const BROKER_TRACE_SELECT = `SELECT id, tenant_id, requested_mode, primary_mode, primary_reason, primary_explicit,
        primary_status, primary_latency_ms, primary_projection_kind, primary_projection_ref,
        primary_capture_id, shadow_mode, shadow_status, shadow_latency_ms, shadow_projection_kind,
        shadow_projection_ref, shadow_capture_id, overlap, detail_r2_key, detail_sha256, created_at
 FROM canonical_broker_traces`

function routeFromRow(row: CanonicalBrokerTraceRow): CanonicalBrokerRouteTrace {
  return {
    mode: row.primary_mode,
    reason: row.primary_reason,
    explicit: Boolean(row.primary_explicit),
    dispatchQuery: null,
  }
}

function branchFromRow(
  mode: MemoryQueryMode | null,
  status: CanonicalBrokerBranchStatus,
  latencyMs: number | null,
  projectionKind: CanonicalBrokerBranchTrace['projectionKind'],
  projectionRef: string | null,
  captureId: string | null,
): CanonicalBrokerBranchTrace {
  return { mode, status, latencyMs, itemCount: null, summary: null, projectionKind, projectionRef, captureId, errorMessage: null }
}

function surfacedStatusFromPrimary(status: CanonicalBrokerBranchStatus): CanonicalSearchResult['status'] {
  if (status === 'unavailable') return 'unavailable'
  if (status === 'partial') return 'partial'
  return 'ok'
}

export function viewFromRow(
  row: CanonicalBrokerTraceRow,
  detailStatus: CanonicalBrokerDetailStatus,
): CanonicalBrokerTraceView {
  return {
    queryId: row.id,
    createdAt: row.created_at,
    queryText: null,
    requestedMode: row.requested_mode ?? null,
    route: routeFromRow(row),
    primary: branchFromRow(row.primary_mode, row.primary_status, row.primary_latency_ms, row.primary_projection_kind, row.primary_projection_ref, row.primary_capture_id),
    shadow: branchFromRow(row.shadow_mode, row.shadow_status, row.shadow_latency_ms, row.shadow_projection_kind, row.shadow_projection_ref, row.shadow_capture_id),
    surfaced: { mode: row.primary_mode, status: surfacedStatusFromPrimary(row.primary_status), summary: null, itemCount: null },
    overlap: row.overlap,
    detailStatus,
  }
}

export async function readTraceView(
  row: CanonicalBrokerTraceRow,
  env: Env,
  options: CanonicalMemoryReadOptions,
): Promise<CanonicalBrokerTraceView> {
  if (!row.detail_r2_key) return viewFromRow(row, 'missing')
  if (!options.tmk) return viewFromRow(row, 'undecryptable')
  const stored = await env.R2_OBSERVABILITY.get(row.detail_r2_key)
  if (!stored) return viewFromRow(row, 'missing')
  try {
    const plaintext = await decryptCanonicalPayload(await stored.text(), options.tmk)
    if (row.detail_sha256 && (await sha256Hex(plaintext)) !== row.detail_sha256) throw new Error('broker trace detail hash mismatch')
    const detail = JSON.parse(plaintext) as CanonicalBrokerTraceDetail
    if (detail.queryId !== row.id || detail.tenantId !== row.tenant_id) throw new Error('broker trace detail identity mismatch')
    return {
      queryId: detail.queryId,
      createdAt: detail.createdAt,
      queryText: detail.queryText,
      requestedMode: detail.requestedMode ?? row.requested_mode ?? null,
      route: { ...detail.route, dispatchQuery: detail.route.dispatchQuery ?? null },
      primary: detail.primary,
      shadow: detail.shadow,
      surfaced: detail.surfaced,
      overlap: detail.overlap,
      detailStatus: 'ok',
    }
  } catch {
    return viewFromRow(row, 'undecryptable')
  }
}

export function listItemFromView(view: CanonicalBrokerTraceView): CanonicalBrokerTraceListItem {
  return {
    queryId: view.queryId,
    createdAt: view.createdAt,
    requestedMode: view.requestedMode,
    primaryMode: view.route.mode,
    shadowMode: view.shadow.mode,
    primaryStatus: view.primary.status,
    shadowStatus: view.shadow.status,
    overlap: view.overlap,
    surfacedSummary: view.surfaced.summary,
    detailStatus: view.detailStatus,
  }
}
