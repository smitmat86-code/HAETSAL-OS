// tests/3.3-kek.test.ts
// KEK encrypt/decrypt roundtrip + fetchAndValidateKek paths

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

describe('Cron KEK — encrypt/decrypt', () => {
  const setupTenant = async () => {
    const tenantId = crypto.randomUUID()
    const now = Date.now()
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO tenants
       (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
       VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
    ).bind(tenantId, now, now, crypto.randomUUID(), now).run()
    return tenantId
  }

  it('encryptWithKek + decryptWithKek roundtrip', async () => {
    const mod = await import('../src/cron/kek')
    const keyBytes = crypto.getRandomValues(new Uint8Array(32))
    const kek = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    )
    const plaintext = 'Hello, encrypted world!'
    const encrypted = await mod.encryptWithKek(plaintext, kek)
    expect(encrypted).not.toBe(plaintext)
    const decrypted = await mod.decryptWithKek(encrypted, kek)
    expect(decrypted).toBe(plaintext)
  })

  it('fetchAndValidateKek returns null when expired', async () => {
    const mod = await import('../src/cron/kek')
    const tenantId = await setupTenant()
    await env.D1_US.prepare(
      'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
    ).bind(Date.now() - 1000, tenantId).run()
    const result = await mod.fetchAndValidateKek(tenantId, env)
    expect(result).toBeNull()
  })

  it('fetchAndValidateKek returns null when KV key missing', async () => {
    const mod = await import('../src/cron/kek')
    const tenantId = await setupTenant()
    await env.D1_US.prepare(
      'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
    ).bind(Date.now() + 86400000, tenantId).run()
    const result = await mod.fetchAndValidateKek(tenantId, env)
    expect(result).toBeNull()
  })

  it('fetchAndValidateKek returns CryptoKey when valid', async () => {
    const mod = await import('../src/cron/kek')
    const tenantId = await setupTenant()
    const keyBytes = crypto.getRandomValues(new Uint8Array(32))
    const rawB64 = btoa(String.fromCharCode(...keyBytes))
    await env.D1_US.prepare(
      'UPDATE tenants SET cron_kek_expires_at = ? WHERE id = ?',
    ).bind(Date.now() + 86400000, tenantId).run()
    await env.KV_SESSION.put(`cron_kek:${tenantId}`, rawB64)
    const result = await mod.fetchAndValidateKek(tenantId, env)
    expect(result).not.toBeNull()
    // Verify it works for encryption
    const encrypted = await mod.encryptWithKek('test', result!)
    const decrypted = await mod.decryptWithKek(encrypted, result!)
    expect(decrypted).toBe('test')
  })
})
