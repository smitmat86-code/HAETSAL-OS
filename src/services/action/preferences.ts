import type { Env } from '../../types/env'
import type {
  AuthorizationLevel,
  CapabilityClass,
  TenantActionPreferenceRow,
} from '../../types/action'
import {
  AUTH_LEVEL_ORDINAL,
  CAPABILITY_CLASSES,
  DEFAULT_SEND_DELAY_SECONDS,
  HARD_FLOORS,
} from '../../types/action'
import {
  mapPreferenceSetting,
  type PreferenceSetting,
  type PreferenceUpdateInput,
  type TenantSettingsRow,
  type TenantSettingsSnapshot,
} from './preference-model'
import { computePreferenceHmac } from './authorization'

export async function readTenantSettings(
  tenantId: string,
  env: Env,
): Promise<TenantSettingsSnapshot> {
  const tenant = await env.D1_US.prepare(
    `SELECT primary_channel, primary_phone, primary_email,
            ai_cost_daily_usd, ai_cost_monthly_usd, ai_cost_reset_at,
            ai_ceiling_daily_usd, ai_ceiling_monthly_usd
     FROM tenants
     WHERE id = ?`,
  ).bind(tenantId).first<TenantSettingsRow>()

  if (!tenant) throw new Error('TENANT_NOT_FOUND')

  const rows = await env.D1_US.prepare(
    `SELECT * FROM tenant_action_preferences
     WHERE tenant_id = ? AND integration IS NULL`,
  ).bind(tenantId).all<TenantActionPreferenceRow>()

  const byCapability = new Map(rows.results.map(row => [row.capability_class, row]))

  const preferences = await Promise.all(
    CAPABILITY_CLASSES.map(async (capabilityClass) => {
      const row = byCapability.get(capabilityClass) ?? null
      return mapPreferenceSetting(capabilityClass, row, env.HMAC_SECRET)
    }),
  )

  return { tenant, preferences }
}

export async function upsertTenantPreference(
  tenantId: string,
  actor: string,
  input: PreferenceUpdateInput,
  env: Env,
): Promise<PreferenceSetting> {
  if (input.integration != null) throw new Error('INTEGRATION_NOT_SUPPORTED')

  const hardFloor = HARD_FLOORS[input.capability_class]
  if (AUTH_LEVEL_ORDINAL[input.authorization_level] < AUTH_LEVEL_ORDINAL[hardFloor]) {
    throw new Error('BELOW_HARD_FLOOR')
  }

  const existing = await env.D1_US.prepare(
    `SELECT * FROM tenant_action_preferences
     WHERE tenant_id = ? AND capability_class = ? AND integration IS NULL`,
  ).bind(tenantId, input.capability_class).first<TenantActionPreferenceRow>()

  const now = Date.now()
  const rowId = existing?.id ?? crypto.randomUUID()
  const createdAt = existing?.created_at ?? now
  const sendDelaySeconds =
    existing?.send_delay_seconds ?? DEFAULT_SEND_DELAY_SECONDS[input.capability_class] ?? 0
  const confirmedExecutions = existing?.confirmed_executions ?? 0
  const trustThreshold = existing?.trust_threshold ?? 10
  const requiresPhrase = existing?.requires_phrase ?? null

  const rowForHmac = {
    id: rowId,
    tenant_id: tenantId,
    capability_class: input.capability_class,
    integration: null,
    authorization_level: input.authorization_level,
    send_delay_seconds: sendDelaySeconds,
    trust_threshold: trustThreshold,
    requires_phrase: requiresPhrase,
    created_at: createdAt,
  }
  const rowHmac = await computePreferenceHmac(rowForHmac, env.HMAC_SECRET)

  const writePreference = existing
    ? env.D1_US.prepare(
      `UPDATE tenant_action_preferences
       SET authorization_level = ?, send_delay_seconds = ?, confirmed_executions = ?,
           trust_threshold = ?, requires_phrase = ?, row_hmac = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      input.authorization_level,
      sendDelaySeconds,
      confirmedExecutions,
      trustThreshold,
      requiresPhrase,
      rowHmac,
      now,
      rowId,
    )
    : env.D1_US.prepare(
      `INSERT INTO tenant_action_preferences
       (id, tenant_id, capability_class, integration, authorization_level,
        send_delay_seconds, confirmed_executions, trust_threshold, requires_phrase,
        row_hmac, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      rowId,
      tenantId,
      input.capability_class,
      input.authorization_level,
      sendDelaySeconds,
      confirmedExecutions,
      trustThreshold,
      requiresPhrase,
      rowHmac,
      createdAt,
      now,
    )

  await env.D1_US.batch([
    writePreference,
    env.D1_US.prepare(
      `INSERT INTO memory_audit
       (id, tenant_id, created_at, operation, agent_identity)
       VALUES (?, ?, ?, 'settings.preference_updated', ?)`,
    ).bind(crypto.randomUUID(), tenantId, now, actor),
  ])

  const updated = await env.D1_US.prepare(
    `SELECT * FROM tenant_action_preferences
     WHERE tenant_id = ? AND capability_class = ? AND integration IS NULL`,
  ).bind(tenantId, input.capability_class).first<TenantActionPreferenceRow>()

  if (!updated) throw new Error('PREFERENCE_WRITE_FAILED')
  return mapPreferenceSetting(input.capability_class, updated, env.HMAC_SECRET)
}
