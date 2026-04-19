import type { Env } from '../types/env'
import type { CanonicalMemoryStatsResult } from '../types/canonical-memory-query'

interface CountRow {
  capture_count: number
  document_count: number
  chunk_count: number
  operation_count: number
  pending_projection_count: number
  completed_projection_count: number
  failed_projection_count: number
  last_capture_at: number | null
}

interface ScopeRow {
  scope: string
  count: number
}

export async function getCanonicalMemoryStats(
  env: Env,
  tenantId: string,
): Promise<CanonicalMemoryStatsResult> {
  const counts = await env.D1_US.prepare(
    `SELECT
       (SELECT COUNT(*) FROM canonical_captures WHERE tenant_id = ?) AS capture_count,
       (SELECT COUNT(*) FROM canonical_documents WHERE tenant_id = ?) AS document_count,
       (SELECT COUNT(*) FROM canonical_chunks WHERE tenant_id = ?) AS chunk_count,
       (SELECT COUNT(*) FROM canonical_memory_operations WHERE tenant_id = ?) AS operation_count,
       (SELECT COUNT(*) FROM canonical_projection_jobs WHERE tenant_id = ? AND status IN ('accepted', 'queued')) AS pending_projection_count,
       (SELECT COUNT(*) FROM canonical_projection_jobs WHERE tenant_id = ? AND status = 'completed') AS completed_projection_count,
       (SELECT COUNT(*) FROM canonical_projection_jobs WHERE tenant_id = ? AND status = 'failed') AS failed_projection_count,
       (SELECT MAX(captured_at) FROM canonical_captures WHERE tenant_id = ?) AS last_capture_at`,
  ).bind(tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId).first<CountRow>()

  const scopes = await env.D1_US.prepare(
    `SELECT scope, COUNT(*) AS count
     FROM canonical_captures
     WHERE tenant_id = ?
     GROUP BY scope
     ORDER BY count DESC, scope ASC`,
  ).bind(tenantId).all<ScopeRow>()

  return {
    captureCount: counts?.capture_count ?? 0,
    documentCount: counts?.document_count ?? 0,
    chunkCount: counts?.chunk_count ?? 0,
    operationCount: counts?.operation_count ?? 0,
    pendingProjectionCount: counts?.pending_projection_count ?? 0,
    completedProjectionCount: counts?.completed_projection_count ?? 0,
    failedProjectionCount: counts?.failed_projection_count ?? 0,
    lastCaptureAt: counts?.last_capture_at ?? null,
    scopes: (scopes.results ?? []).map(row => ({ scope: row.scope, count: row.count })),
  }
}
