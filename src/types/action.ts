// src/types/action.ts
// Action layer types — capability classes, authorization levels, queue message schema
// Column names verified against migrations/1004_brain_action_layer.sql

export type CapabilityClass =
  | 'READ'
  | 'WRITE_INTERNAL'
  | 'WRITE_EXTERNAL_REVERSIBLE'
  | 'WRITE_EXTERNAL_IRREVERSIBLE'
  | 'WRITE_EXTERNAL_FINANCIAL'
  | 'DELETE'

export type AuthorizationLevel = 'GREEN' | 'YELLOW' | 'RED'

// Ordinal for comparison — higher = more restrictive
export const AUTH_LEVEL_ORDINAL: Record<AuthorizationLevel, number> = {
  GREEN: 0, YELLOW: 1, RED: 2,
}

export const HARD_FLOORS: Record<CapabilityClass, AuthorizationLevel> = {
  READ:                          'GREEN',
  WRITE_INTERNAL:                'GREEN',
  WRITE_EXTERNAL_REVERSIBLE:     'YELLOW',
  WRITE_EXTERNAL_IRREVERSIBLE:   'YELLOW',
  WRITE_EXTERNAL_FINANCIAL:      'RED',
  DELETE:                        'RED',
}

export const DEFAULT_SEND_DELAY_SECONDS: Partial<Record<CapabilityClass, number>> = {
  WRITE_EXTERNAL_IRREVERSIBLE: 120,
  WRITE_EXTERNAL_FINANCIAL:    120,
}

// ── Queue message schema (published by McpAgent DO tool stubs) ────────────────
export interface ActionQueueMessage {
  action_id: string
  tenant_id: string
  proposed_by: string       // agent_identity
  tool_name: string
  capability_class: CapabilityClass
  integration: string
  payload_r2_key: string
  payload_hash: string      // SHA-256 hex of plaintext payload
  payload_stub: string      // Phase 1 only — plaintext stub for TOCTOU test
}

// ── Action state machine ──────────────────────────────────────────────────────
export type ActionState =
  | 'pending'
  | 'queued'
  | 'awaiting_approval'
  | 'completed'
  | 'completed_reversible'   // 5-min undo window (Phase 2.3)
  | 'undone'                 // Undo executed within window (Phase 2.3)
  | 'failed'
  | 'rejected'

// Undo window duration in ms (5 minutes)
export const UNDO_WINDOW_MS = 5 * 60 * 1000

// ── D1 row shapes (column names match 1004_brain_action_layer.sql) ────────────
export interface PendingActionRow {
  id: string
  tenant_id: string
  proposed_at: number
  proposed_by: string
  capability_class: CapabilityClass
  integration: string
  action_type: string
  state: ActionState
  authorization_level: AuthorizationLevel
  send_delay_seconds: number
  execute_after: number | null
  payload_r2_key: string
  payload_hash: string
  approved_by: string | null
  approved_at: number | null
  executed_at: number | null
  cancelled_at: number | null
  cancel_reason: string | null
  retry_count: number
  max_retries: number
  result_summary: string | null
  episodic_memory_id: string | null
}

export interface TenantActionPreferenceRow {
  id: string
  tenant_id: string
  capability_class: CapabilityClass
  integration: string | null
  authorization_level: AuthorizationLevel
  send_delay_seconds: number
  confirmed_executions: number
  trust_threshold: number
  requires_phrase: string | null
  row_hmac: string
  created_at: number
  updated_at: number
}
