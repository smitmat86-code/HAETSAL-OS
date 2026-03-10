// tests/2.2-oauth.test.ts
// Google OAuth token management tests — encryption, storage, revocation

import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { storeEncryptedTokens, revokeGoogleTokens } from '../src/services/google/oauth'
import type { GoogleOAuthTokens } from '../src/types/google'

async function deriveTestTmk(): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('test-oauth-key'),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('test'), info: new TextEncoder().encode('oauth') },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const TEST_TENANT = 'oauth-test-tenant'

beforeAll(async () => {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TEST_TENANT, now, now, `hindsight-${TEST_TENANT}`, now).run()
})

describe('Google OAuth token management', () => {
  it('stores tokens encrypted in KV (not plaintext) — Law 2', async () => {
    const tmk = await deriveTestTmk()
    const tokens: GoogleOAuthTokens = {
      access_token: 'ya29.super-secret-access-token',
      refresh_token: '1//super-secret-refresh-token',
      expires_at: Date.now() + 3600_000,
      scope: 'gmail.readonly',
    }

    await storeEncryptedTokens(TEST_TENANT, 'gmail.readonly', tokens, tmk, env)

    // Verify KV has encrypted content (not plaintext)
    const kvKey = `google_tokens:${TEST_TENANT}:gmail.readonly`
    const stored = await env.KV_SESSION.get(kvKey)
    expect(stored).not.toBeNull()
    expect(stored).not.toContain('ya29.super-secret-access-token')
    expect(stored).not.toContain('1//super-secret-refresh-token')
  })

  it('stores metadata in D1 google_oauth_tokens', async () => {
    // Self-contained: store first (isolated storage per test)
    const tmk = await deriveTestTmk()
    const tokens: GoogleOAuthTokens = {
      access_token: 'ya29.d1-test-token',
      refresh_token: '1//d1-test-refresh',
      expires_at: Date.now() + 3600_000,
      scope: 'gmail.readonly',
    }
    await storeEncryptedTokens(TEST_TENANT, 'gmail.readonly', tokens, tmk, env)

    const row = await env.D1_US.prepare(
      `SELECT * FROM google_oauth_tokens WHERE tenant_id = ? AND scope = ?`,
    ).bind(TEST_TENANT, 'gmail.readonly').first()

    expect(row).not.toBeNull()
    expect(row!.tenant_id).toBe(TEST_TENANT)
    expect(row!.scope).toBe('gmail.readonly')
    expect(row!.kv_key).toBe(`google_tokens:${TEST_TENANT}:gmail.readonly`)
  })

  it('revoke clears KV + D1', async () => {
    // Self-contained: store first, then revoke (isolated storage per test)
    const tmk = await deriveTestTmk()
    const tokens: GoogleOAuthTokens = {
      access_token: 'ya29.revoke-test-token',
      refresh_token: '1//revoke-test-refresh',
      expires_at: Date.now() + 3600_000,
      scope: 'gmail.readonly',
    }
    await storeEncryptedTokens(TEST_TENANT, 'gmail.readonly', tokens, tmk, env)

    // Verify they exist
    const kvBefore = await env.KV_SESSION.get(`google_tokens:${TEST_TENANT}:gmail.readonly`)
    expect(kvBefore).not.toBeNull()

    await revokeGoogleTokens(TEST_TENANT, 'gmail.readonly', env)

    // KV should be cleared
    const kvAfter = await env.KV_SESSION.get(`google_tokens:${TEST_TENANT}:gmail.readonly`)
    expect(kvAfter).toBeNull()

    // D1 record should be deleted
    const d1After = await env.D1_US.prepare(
      `SELECT * FROM google_oauth_tokens WHERE tenant_id = ? AND scope = ?`,
    ).bind(TEST_TENANT, 'gmail.readonly').first()
    expect(d1After).toBeNull()
  })

  it('google_webhook_channels table accepts records', async () => {
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO google_webhook_channels
       (id, tenant_id, channel_id, channel_token, resource_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'gmail', ?, ?)`,
    ).bind(
      crypto.randomUUID(), TEST_TENANT, 'ch-123', 'token-abc',
      Date.now() + 86400_000, Date.now(),
    ).run()

    const row = await env.D1_US.prepare(
      `SELECT * FROM google_webhook_channels WHERE channel_token = ?`,
    ).bind('token-abc').first()

    expect(row).not.toBeNull()
    expect(row!.tenant_id).toBe(TEST_TENANT)
    expect(row!.resource_type).toBe('gmail')
  })
})
