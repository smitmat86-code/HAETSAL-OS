import type { Env } from '../types/env'
import { getWebhookHealth, type HindsightWebhookHealth } from './hindsight-ops-webhooks'

export const HINDSIGHT_PENDING_SLOW_MS = 2 * 60 * 1000
export const HINDSIGHT_PENDING_STUCK_MS = 10 * 60 * 1000

export type HindsightQueueState = 'pending' | 'available' | 'delayed' | 'stuck' | 'completed' | 'failed'

interface SummaryRow {
  total_count: number
  pending_count: number
  available_pending_count: number
  delayed_count: number
  stuck_count: number
  completed_count: number
  failed_count: number
  last_requested_at: number | null
  last_completed_at: number | null
  last_failed_at: number | null
  bank_id: string | null
}

interface RecentRow {
  operation_id: string
  status: string
  requested_at: number
  updated_at: number
  completed_at: number | null
  available_at: number | null
  slow_at: number | null
  stuck_at: number | null
  source: string
  domain: string | null
  memory_type: string | null
  source_document_id: string | null
  error_message: string | null
}

export interface HindsightMemoryOpsSnapshot {
  summary: {
    totalCount: number
    pendingCount: number
    availablePendingCount: number
    delayedCount: number
    stuckCount: number
    completedCount: number
    failedCount: number
    bankId: string | null
    lastRequestedAt: number | null
    lastCompletedAt: number | null
    lastFailedAt: number | null
    webhookHealth: HindsightWebhookHealth
  }
  recent: {
    operationId: string
    queueState: HindsightQueueState
    status: string
    requestedAt: number
    updatedAt: number
    completedAt: number | null
    availableAt: number | null
    source: string
    domain: string | null
    memoryType: string | null
    sourceDocumentId: string | null
    errorMessage: string | null
  }[]
}

export async function getHindsightMemoryOpsSnapshot(
  env: Env,
  tenantId: string,
): Promise<HindsightMemoryOpsSnapshot> {
  const now = Date.now()
  const slowCutoff = now - HINDSIGHT_PENDING_SLOW_MS
  const stuckCutoff = now - HINDSIGHT_PENDING_STUCK_MS

  const summary = await env.D1_US.prepare(
    `SELECT
       COUNT(*) AS total_count,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status = 'pending' AND available_at IS NOT NULL THEN 1 ELSE 0 END) AS available_pending_count,
       SUM(CASE WHEN status = 'pending' AND requested_at <= ? THEN 1 ELSE 0 END) AS delayed_count,
       SUM(CASE WHEN status = 'pending' AND requested_at <= ? THEN 1 ELSE 0 END) AS stuck_count,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
       MAX(requested_at) AS last_requested_at,
       MAX(completed_at) AS last_completed_at,
       MAX(CASE WHEN status = 'failed' THEN updated_at ELSE NULL END) AS last_failed_at,
       MAX(bank_id) AS bank_id
     FROM hindsight_operations
     WHERE tenant_id = ?`,
  ).bind(slowCutoff, stuckCutoff, tenantId).first<SummaryRow>()

  const recent = await env.D1_US.prepare(
    `SELECT operation_id, status, requested_at, updated_at, completed_at, available_at,
            slow_at, stuck_at, source, domain, memory_type, source_document_id, error_message
     FROM hindsight_operations
     WHERE tenant_id = ?
     ORDER BY requested_at DESC
     LIMIT 20`,
  ).bind(tenantId).all<RecentRow>()

  const webhookHealth = await getWebhookHealth(env, summary?.bank_id ?? null)

  return {
    summary: {
      totalCount: summary?.total_count ?? 0,
      pendingCount: summary?.pending_count ?? 0,
      availablePendingCount: summary?.available_pending_count ?? 0,
      delayedCount: summary?.delayed_count ?? 0,
      stuckCount: summary?.stuck_count ?? 0,
      completedCount: summary?.completed_count ?? 0,
      failedCount: summary?.failed_count ?? 0,
      bankId: summary?.bank_id ?? null,
      lastRequestedAt: summary?.last_requested_at ?? null,
      lastCompletedAt: summary?.last_completed_at ?? null,
      lastFailedAt: summary?.last_failed_at ?? null,
      webhookHealth,
    },
    recent: (recent.results ?? []).map((row) => ({
      operationId: row.operation_id,
      queueState: deriveQueueState(row, now),
      status: row.status,
      requestedAt: row.requested_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      availableAt: row.available_at,
      source: row.source,
      domain: row.domain,
      memoryType: row.memory_type,
      sourceDocumentId: row.source_document_id,
      errorMessage: row.error_message,
    })),
  }
}

export function deriveQueueState(
  row: Pick<RecentRow, 'status' | 'requested_at' | 'available_at' | 'slow_at' | 'stuck_at'>,
  now = Date.now(),
): HindsightQueueState {
  if (row.status === 'completed') return 'completed'
  if (row.status === 'failed') return 'failed'
  if (row.stuck_at != null || row.requested_at <= now - HINDSIGHT_PENDING_STUCK_MS) return 'stuck'
  if (row.available_at != null) return 'available'
  if (row.slow_at != null || row.requested_at <= now - HINDSIGHT_PENDING_SLOW_MS) return 'delayed'
  return 'pending'
}
