// src/services/action/authorization.ts
// Auth gate: capability class → effective level
// HMAC verification, hard floor enforcement, preference lookup

import type { Env } from '../../types/env'
import type {
  CapabilityClass, AuthorizationLevel, TenantActionPreferenceRow
} from '../../types/action'
import { AUTH_LEVEL_ORDINAL, HARD_FLOORS, DEFAULT_SEND_DELAY_SECONDS } from '../../types/action'

export interface AuthGateResult {
  effectiveLevel: AuthorizationLevel
  sendDelaySeconds: number
  hmacValid: boolean
  preferenceFound: boolean
}

export async function runAuthorizationGate(
  tenantId: string,
  capabilityClass: CapabilityClass,
  integration: string,
  env: Env
): Promise<AuthGateResult> {
  const hardFloor = HARD_FLOORS[capabilityClass]

  // Look up tenant preference — specific integration first, then wildcard
  const pref = await lookupPreference(tenantId, capabilityClass, integration, env)

  if (!pref) {
    // No preference configured — use hard floor as default
    return {
      effectiveLevel: hardFloor,
      sendDelaySeconds: DEFAULT_SEND_DELAY_SECONDS[capabilityClass] ?? 0,
      hmacValid: true,  // No row = no HMAC to verify
      preferenceFound: false,
    }
  }

  // Verify HMAC before trusting the row
  const hmacValid = await verifyPreferenceHmac(pref, env.HMAC_SECRET)

  if (!hmacValid) {
    // HMAC failure — treat as RED regardless of stored value
    return {
      effectiveLevel: 'RED',
      sendDelaySeconds: 0,
      hmacValid: false,
      preferenceFound: true,
    }
  }

  // Effective level = max(preference, hard floor)
  const prefOrdinal = AUTH_LEVEL_ORDINAL[pref.authorization_level]
  const floorOrdinal = AUTH_LEVEL_ORDINAL[hardFloor]
  const effectiveLevel: AuthorizationLevel =
    prefOrdinal >= floorOrdinal ? pref.authorization_level : hardFloor

  return {
    effectiveLevel,
    sendDelaySeconds: pref.send_delay_seconds,
    hmacValid: true,
    preferenceFound: true,
  }
}

async function lookupPreference(
  tenantId: string,
  capabilityClass: CapabilityClass,
  integration: string,
  env: Env
): Promise<TenantActionPreferenceRow | null> {
  // Try specific integration first, fall back to wildcard (integration IS NULL)
  const db = env.D1_US
  const specific = await db.prepare(
    `SELECT * FROM tenant_action_preferences
     WHERE tenant_id = ? AND capability_class = ? AND integration = ?`
  ).bind(tenantId, capabilityClass, integration).first<TenantActionPreferenceRow>()
  if (specific) return specific

  return db.prepare(
    `SELECT * FROM tenant_action_preferences
     WHERE tenant_id = ? AND capability_class = ? AND integration IS NULL`
  ).bind(tenantId, capabilityClass).first<TenantActionPreferenceRow>()
}

async function verifyPreferenceHmac(
  pref: TenantActionPreferenceRow,
  hmacSecret: string
): Promise<boolean> {
  // Canonical JSON — exclude row_hmac field itself
  const canonical = canonicalPrefJson(pref)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )
  try {
    const storedHmac = Uint8Array.from(atob(pref.row_hmac), c => c.charCodeAt(0))
    return crypto.subtle.verify('HMAC', key, storedHmac, new TextEncoder().encode(canonical))
  } catch {
    return false // Invalid base64 or corrupted HMAC → treat as invalid
  }
}

// Exported for use by Phase 1.4 (settings UI — creating/updating preferences)
export async function computePreferenceHmac(
  pref: Omit<TenantActionPreferenceRow, 'row_hmac' | 'updated_at' | 'confirmed_executions'>,
  hmacSecret: string
): Promise<string> {
  const canonical = canonicalPrefJson(pref as TenantActionPreferenceRow)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

function canonicalPrefJson(pref: TenantActionPreferenceRow): string {
  return JSON.stringify({
    id: pref.id,
    tenant_id: pref.tenant_id,
    capability_class: pref.capability_class,
    integration: pref.integration,
    authorization_level: pref.authorization_level,
    send_delay_seconds: pref.send_delay_seconds,
    trust_threshold: pref.trust_threshold,
    requires_phrase: pref.requires_phrase,
    created_at: pref.created_at,
  })
}
