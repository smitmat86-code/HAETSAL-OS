export type AuthorizationLevel = 'GREEN' | 'YELLOW' | 'RED'
export type CapabilityClass =
  | 'READ'
  | 'WRITE_INTERNAL'
  | 'WRITE_EXTERNAL_REVERSIBLE'
  | 'WRITE_EXTERNAL_IRREVERSIBLE'
  | 'WRITE_EXTERNAL_FINANCIAL'
  | 'DELETE'

export type ActionState =
  | 'pending'
  | 'queued'
  | 'awaiting_approval'
  | 'completed'
  | 'completed_reversible'
  | 'undone'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired'

// Canonical source: src/types/action.ts
export const UNDO_WINDOW_MS = 300_000

export interface ActionRow {
  id: string
  proposed_at: number
  proposed_by: string
  tool_name: string
  capability_class: CapabilityClass
  integration: string
  action_type: string
  state: ActionState
  authorization_level: AuthorizationLevel
  send_delay_seconds: number
  execute_after: number | null
  approved_by: string | null
  approved_at: number | null
  executed_at: number | null
  cancel_reason: string | null
  result_summary: string | null
  episodic_memory_id: string | null
  undo_expires_at?: number | null
}

export interface AuditRow {
  id: string
  action_id: string
  created_at: number
  event: string
  agent_identity: string | null
  detail_json: string | null
  tool_name: string
  integration: string
  state: ActionState
  result_summary: string | null
}

export interface PreferenceSetting {
  capability_class: CapabilityClass
  authorization_level: AuthorizationLevel
  effective_level: AuthorizationLevel
  hard_floor: AuthorizationLevel
  send_delay_seconds: number
  updated_at: number | null
  hmac_valid: boolean
}

export interface SettingsData {
  tenant: {
    primary_channel: string
    primary_phone: string | null
    primary_email: string | null
    ai_cost_daily_usd: number
    ai_cost_monthly_usd: number
    ai_cost_reset_at: number
    ai_ceiling_daily_usd: number
    ai_ceiling_monthly_usd: number
  }
  preferences: PreferenceSetting[]
}
