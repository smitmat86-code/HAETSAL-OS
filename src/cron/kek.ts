// src/cron/kek.ts
// KEK fetch, validate, derive CryptoKey from raw KV bytes
// LESSON: KEK expiry is silent — defer entire run, never crash
// The KEK is the TMK raw bytes stored in KV with 24h TTL
// Security: KV exposure limited to 24h after last active session

import type { Env } from '../types/env'

export async function fetchAndValidateKek(
  tenantId: string,
  env: Env,
): Promise<CryptoKey | null> {
  // Check expiry from D1 first (fast, no KV read if expired)
  const tenant = await env.D1_US.prepare(
    'SELECT cron_kek_expires_at FROM tenants WHERE id = ?',
  ).bind(tenantId).first<{ cron_kek_expires_at: number | null }>()

  if (!tenant?.cron_kek_expires_at || tenant.cron_kek_expires_at < Date.now()) {
    await writeDeferredAnomaly(tenantId, env)
    return null
  }

  // Fetch raw key bytes from KV
  const rawB64 = await env.KV_SESSION.get(`cron_kek:${tenantId}`)
  if (!rawB64) {
    await writeDeferredAnomaly(tenantId, env)
    return null
  }

  const rawBytes = Uint8Array.from(atob(rawB64), c => c.charCodeAt(0))
  return crypto.subtle.importKey(
    'raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
}

async function writeDeferredAnomaly(tenantId: string, env: Env): Promise<void> {
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO anomaly_signals
     (id, tenant_id, created_at, signal_type, severity, detail_json)
     VALUES (?, ?, ?, 'cron_kek_expired', 'low', '{"source":"cron_deferred"}')`,
  ).bind(crypto.randomUUID(), tenantId, Date.now()).run()
}
