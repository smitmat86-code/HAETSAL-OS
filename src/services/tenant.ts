// src/services/tenant.ts
// Tenant bootstrap, KEK provision/renewal, scheduled_tasks seed
// All D1 writes are batched — never sequential for paired operations

import type { Env } from '../types/env'
import type { TenantRow } from '../types/tenant'

const PLATFORM_DEFAULT_TASKS = [
  { task_name: 'consolidation_cron', cron_expression: '0 3 * * *', description: 'Nightly memory consolidation' },
  { task_name: 'morning_brief', cron_expression: '0 7 * * *', description: 'Daily morning brief generation' },
  { task_name: 'gap_discovery', cron_expression: '0 4 * * 0', description: 'Weekly knowledge gap discovery' },
  { task_name: 'weekly_synthesis', cron_expression: '0 8 * * 1', description: 'Weekly synthesis and reflection' },
]

// Register tenant with Hindsight Container via service binding
async function registerHindsightTenant(tenantId: string, env: Env): Promise<string> {
  const hindsightTenantId = crypto.randomUUID()
  try {
    await env.HINDSIGHT.fetch('http://internal/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: tenantId, hindsight_tenant_id: hindsightTenantId }),
    })
  } catch {
    // Container may be stubbed in dev/test — proceed with generated ID
  }
  return hindsightTenantId
}

export async function getOrCreateTenant(
  tenantId: string,
  jwtSub: string,
  env: Env,
): Promise<{ tenant: TenantRow; isNew: boolean }> {
  const db = env.D1_US // TODO: Phase 5+ — route by data_region for DLS
  const existing = await db.prepare(
    'SELECT * FROM tenants WHERE id = ?',
  ).bind(tenantId).first<TenantRow>()

  if (existing) return { tenant: existing, isNew: false }

  // First auth — register with Hindsight and create tenant row atomically
  const hindsightTenantId = await registerHindsightTenant(tenantId, env)

  const now = Date.now()
  const taskRows = PLATFORM_DEFAULT_TASKS.map(t => ({
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    task_name: t.task_name,
    cron_expression: t.cron_expression,
    enabled: 1,
    is_platform_default: 1,
    description: t.description,
    created_at: now,
    updated_at: now,
  }))

  // Atomic: tenant INSERT + all scheduled_tasks + audit record in one batch
  // LESSON: Atomic — no TOCTOU, no paired sequential writes
  await db.batch([
    db.prepare(
      `INSERT INTO tenants (id, created_at, updated_at, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(tenantId, now, now, hindsightTenantId, now),
    ...taskRows.map(t =>
      db.prepare(
        `INSERT INTO scheduled_tasks
         (id, tenant_id, task_name, cron_expression, enabled, is_platform_default,
          description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(t.id, t.tenant_id, t.task_name, t.cron_expression, t.enabled,
        t.is_platform_default, t.description, t.created_at, t.updated_at),
    ),
    db.prepare(
      `INSERT INTO memory_audit (id, tenant_id, created_at, operation)
       VALUES (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), tenantId, now, 'auth.tenant_created'),
  ])

  const tenant = await db.prepare(
    'SELECT * FROM tenants WHERE id = ?',
  ).bind(tenantId).first<TenantRow>()

  return { tenant: tenant!, isNew: true }
}

// Decrypt KEK ciphertext using TMK — for KEK renewal (re-encrypt with fresh IV)
async function decryptKek(ciphertext: string, tmk: CryptoKey): Promise<Uint8Array> {
  const raw = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0))
  const iv = raw.slice(0, 12)
  const encrypted = raw.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, tmk, encrypted)
  return new Uint8Array(decrypted)
}

export async function provisionOrRenewKek(
  tenant: TenantRow,
  tmk: CryptoKey,
  env: Env,
): Promise<void> {
  const db = env.D1_US
  const now = Date.now()
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

  const needsProvision = !tenant.cron_kek_encrypted
  const needsRenewal = tenant.cron_kek_expires_at
    ? tenant.cron_kek_expires_at - now < TWO_HOURS_MS
    : false

  if (!needsProvision && !needsRenewal) return

  // Generate or re-encrypt KEK
  const kekBytes = needsProvision
    ? crypto.getRandomValues(new Uint8Array(32))
    : await decryptKek(tenant.cron_kek_encrypted!, tmk)

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tmk, kekBytes)
  const combined = new Uint8Array([...iv, ...new Uint8Array(encrypted)])
  const ciphertext = btoa(String.fromCharCode(...combined))

  // Store raw key bytes in KV for cron access (Law 2: accepted 24h exposure window)
  const rawB64 = btoa(String.fromCharCode(...kekBytes))
  await env.KV_SESSION.put(`cron_kek:${tenant.id}`, rawB64, {
    expirationTtl: Math.floor(TWENTY_FOUR_HOURS_MS / 1000),
  })

  const operation = needsProvision ? 'auth.kek_provisioned' : 'auth.kek_renewed'

  // Atomic: tenants UPDATE + audit in one batch
  await db.batch([
    db.prepare(
      `UPDATE tenants SET cron_kek_encrypted = ?, cron_kek_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(ciphertext, now + TWENTY_FOUR_HOURS_MS, now, tenant.id),
    db.prepare(
      `INSERT INTO memory_audit (id, tenant_id, created_at, operation)
       VALUES (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), tenant.id, now, operation),
  ])
}
