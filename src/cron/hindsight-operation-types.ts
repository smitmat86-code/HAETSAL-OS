export interface PendingOperationRow {
  operation_id: string
  tenant_id: string
  bank_id: string
  source_document_id: string | null
  memory_type: string | null
  domain: string | null
  provenance: string | null
  salience_tier: number | null
  available_at: number | null
  requested_at: number
  slow_at: number | null
  stuck_at: number | null
}

export interface OperationStateRow {
  status: string
  available_at: number | null
}

export const MAX_POLLS_PER_TICK = 50
export const MIN_RECHECK_MS = 30_000
export const MIN_AVAILABILITY_RECHECK_MS = 15_000
export const IMMEDIATE_RECONCILIATION_DELAYS_MS = [0, 10_000, 25_000] as const
