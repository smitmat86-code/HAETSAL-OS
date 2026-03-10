import type { AuthorizationLevel, CapabilityClass, TenantActionPreferenceRow } from '../../types/action'
import {
  AUTH_LEVEL_ORDINAL,
  DEFAULT_SEND_DELAY_SECONDS,
  HARD_FLOORS,
} from '../../types/action'
import { computePreferenceHmac } from './authorization'

export interface PreferenceSetting {
  capability_class: CapabilityClass
  authorization_level: AuthorizationLevel
  effective_level: AuthorizationLevel
  hard_floor: AuthorizationLevel
  send_delay_seconds: number
  updated_at: number | null
  hmac_valid: boolean
}

export interface TenantSettingsSnapshot {
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

export interface PreferenceUpdateInput {
  capability_class: CapabilityClass
  authorization_level: AuthorizationLevel
  integration?: string | null
}

export type TenantSettingsRow = TenantSettingsSnapshot['tenant']

export async function mapPreferenceSetting(
  capabilityClass: CapabilityClass,
  row: TenantActionPreferenceRow | null,
  hmacSecret: string,
): Promise<PreferenceSetting> {
  const hardFloor = HARD_FLOORS[capabilityClass]
  if (!row) {
    return {
      capability_class: capabilityClass,
      authorization_level: hardFloor,
      effective_level: hardFloor,
      hard_floor: hardFloor,
      send_delay_seconds: DEFAULT_SEND_DELAY_SECONDS[capabilityClass] ?? 0,
      updated_at: null,
      hmac_valid: true,
    }
  }

  const hmacValid = await verifyPreferenceRow(row, hmacSecret)
  const effectiveLevel = !hmacValid
    ? 'RED'
    : AUTH_LEVEL_ORDINAL[row.authorization_level] >= AUTH_LEVEL_ORDINAL[hardFloor]
      ? row.authorization_level
      : hardFloor

  return {
    capability_class: capabilityClass,
    authorization_level: row.authorization_level,
    effective_level: effectiveLevel,
    hard_floor: hardFloor,
    send_delay_seconds: hmacValid ? row.send_delay_seconds : 0,
    updated_at: row.updated_at,
    hmac_valid: hmacValid,
  }
}

async function verifyPreferenceRow(
  row: TenantActionPreferenceRow,
  hmacSecret: string,
): Promise<boolean> {
  const expected = await computePreferenceHmac({
    id: row.id,
    tenant_id: row.tenant_id,
    capability_class: row.capability_class,
    integration: row.integration,
    authorization_level: row.authorization_level,
    send_delay_seconds: row.send_delay_seconds,
    trust_threshold: row.trust_threshold,
    requires_phrase: row.requires_phrase,
    created_at: row.created_at,
  }, hmacSecret)

  const actualBytes = new TextEncoder().encode(row.row_hmac)
  const expectedBytes = new TextEncoder().encode(expected)
  if (actualBytes.length !== expectedBytes.length) return false
  return crypto.subtle.timingSafeEqual(actualBytes, expectedBytes)
}
