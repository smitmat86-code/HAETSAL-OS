import type { Env } from '../types/env'
import type { CanonicalMemoryStatsResult } from '../types/canonical-memory-query'
import { getCanonicalMemoryStore } from './canonical-postgres'

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
  const counts = await getCanonicalMemoryStore(env).getStats(tenantId)

  return {
    captureCount: counts.captureCount,
    documentCount: counts.documentCount,
    chunkCount: counts.chunkCount,
    operationCount: counts.operationCount,
    pendingProjectionCount: counts.pendingProjectionCount,
    completedProjectionCount: counts.completedProjectionCount,
    failedProjectionCount: counts.failedProjectionCount,
    lastCaptureAt: counts.lastCaptureAt,
    scopes: counts.scopes,
  }
}
