// src/services/google/oauth.ts
// Google OAuth token management — encrypt/decrypt via TMK, store in KV
// Law 2: tokens encrypted before KV write, decrypted with TMK on read

import type { Env } from '../../types/env'
import type { GoogleOAuthTokens } from '../../types/google'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

async function encryptTokens(tokens: GoogleOAuthTokens, tmk: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(tokens))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tmk, data)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function decryptTokens(encrypted: string, tmk: CryptoKey): Promise<GoogleOAuthTokens> {
  const combined = new Uint8Array(atob(encrypted).split('').map(c => c.charCodeAt(0)))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, tmk, ciphertext)
  return JSON.parse(new TextDecoder().decode(decrypted))
}

export async function exchangeCodeForTokens(
  code: string, redirectUri: string, env: Env,
): Promise<GoogleOAuthTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: (env as Record<string, string>).GOOGLE_CLIENT_ID ?? '',
      client_secret: (env as Record<string, string>).GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const data = await res.json() as Record<string, unknown>
  return {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string,
    expires_at: Date.now() + ((data.expires_in as number) * 1000),
    scope: data.scope as string,
  }
}

export async function storeEncryptedTokens(
  tenantId: string, scope: string, tokens: GoogleOAuthTokens, tmk: CryptoKey, env: Env,
): Promise<void> {
  const kvKey = `google_tokens:${tenantId}:${scope}`
  const encrypted = await encryptTokens(tokens, tmk)
  await env.KV_SESSION.put(kvKey, encrypted, { expirationTtl: 86400 * 30 })

  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT INTO google_oauth_tokens (id, tenant_id, scope, kv_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, scope) DO UPDATE SET kv_key = ?, updated_at = ?`,
  ).bind(crypto.randomUUID(), tenantId, scope, kvKey, now, now, kvKey, now).run()
}

export async function getGoogleToken(
  tenantId: string, scope: string, tmk: CryptoKey, env: Env,
): Promise<string | null> {
  const kvKey = `google_tokens:${tenantId}:${scope}`
  const encrypted = await env.KV_SESSION.get(kvKey)
  if (!encrypted) return null

  const tokens = await decryptTokens(encrypted, tmk)

  // Auto-refresh if expired (5-minute buffer)
  if (tokens.expires_at < Date.now() + 300_000) {
    const refreshed = await refreshGoogleToken(tenantId, scope, tokens.refresh_token, tmk, env)
    return refreshed
  }

  return tokens.access_token
}

async function refreshGoogleToken(
  tenantId: string, scope: string, refreshToken: string, tmk: CryptoKey, env: Env,
): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: (env as Record<string, string>).GOOGLE_CLIENT_ID ?? '',
      client_secret: (env as Record<string, string>).GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json() as Record<string, unknown>
  const newTokens: GoogleOAuthTokens = {
    access_token: data.access_token as string,
    refresh_token: refreshToken,
    expires_at: Date.now() + ((data.expires_in as number) * 1000),
    scope,
  }
  await storeEncryptedTokens(tenantId, scope, newTokens, tmk, env)
  return newTokens.access_token
}

export async function revokeGoogleTokens(tenantId: string, scope: string, env: Env): Promise<void> {
  const kvKey = `google_tokens:${tenantId}:${scope}`
  await env.KV_SESSION.delete(kvKey)
  await env.D1_US.prepare(
    `DELETE FROM google_oauth_tokens WHERE tenant_id = ? AND scope = ?`,
  ).bind(tenantId, scope).run()
}
