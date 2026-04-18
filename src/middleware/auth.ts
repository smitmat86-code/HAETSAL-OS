// src/middleware/auth.ts
// CF Access JWT validation + TMK derivation
// LESSON: TenantContext Wiring — stamp onto Hono context here.
//         Routes without auditMiddleware must access c.get('tenantId') directly.

import type { Env } from '../types/env'

type AuthVariables = {
  tenantId: string
  jwtSub: string
}

// HKDF-SHA256: JWT sub → tenant_id
// Deterministic — same sub always produces same tenant_id
// DO NOT store tenantId in D1 as the JWT sub directly (PII risk)
export async function deriveTenantId(sub: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('brain-tenant-id'),
      info: new TextEncoder().encode(sub),
    },
    keyMaterial,
    256,
  )
  return Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// TMK derivation — held in DO memory only, never written to disk
// Called from McpAgent DO on each new session
export async function deriveTmk(sub: string, secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('brain-tmk'),
      info: new TextEncoder().encode(sub),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // NOT extractable — can never be serialized out of memory
    ['encrypt', 'decrypt'],
  )
}

// Validate CF Access JWT against Cloudflare's JWKs endpoint
// Uses crypto.subtle — no third-party JWT library (workerd-native)
export async function validateCfAccessJwt(
  jwt: string,
  jwksUrl: string,
  expectedAud: string | string[],
): Promise<{ sub: string; aud: string | string[]; exp: number }> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')

  const header = JSON.parse(atob(parts[0]))
  const payload = JSON.parse(atob(parts[1]))

  // Validate expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired')
  }

  // Validate audience — supports multiple expected AUDs (Worker + Pages)
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  const expected = Array.isArray(expectedAud) ? expectedAud : [expectedAud]
  if (!aud.some(a => expected.includes(a))) throw new Error('Invalid audience')

  // Fetch JWKs and find matching key
  const jwksResponse = await fetch(jwksUrl)
  const jwks = await jwksResponse.json() as { keys: (JsonWebKey & { kid?: string })[] }
  const jwk = jwks.keys.find(k => k.kid === header.kid)
  if (!jwk) throw new Error('No matching JWK found')

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  )

  const signature = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0),
  )
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)
  if (!valid) throw new Error('Invalid JWT signature')

  return payload as { sub: string; aud: string | string[]; exp: number }
}

import { createMiddleware } from 'hono/factory'

export function authMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    // Check standard CF Access header first, then custom proxy-forwarded header
    // CF Access strips CF-Access-Jwt-Assertion on bypass routes, so the Pages proxy
    // copies it to X-Forwarded-Access-Jwt as a fallback
    const jwt = c.req.header('CF-Access-Jwt-Assertion') || c.req.header('X-Forwarded-Access-Jwt')
    if (!jwt) return c.json({ error: 'Unauthorized' }, 401)

    const jwksUrl = `https://${c.env.CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`

    try {
      // Support comma-separated AUDs: "worker-aud,pages-aud"
      const audiences = c.env.CF_ACCESS_AUD.split(',').map((s: string) => s.trim())
      const payload = await validateCfAccessJwt(jwt, jwksUrl, audiences)
      const tenantId = await deriveTenantId(payload.sub, audiences[0])
      c.set('tenantId', tenantId)
      c.set('jwtSub', payload.sub)
    } catch {
      // LESSON: waitUntil for audit — don't block rejection on audit write
      c.executionCtx.waitUntil(writeFailedAuthAudit(c.env))
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  })
}

async function writeFailedAuthAudit(env: Env): Promise<void> {
  try {
    await env.D1_US.prepare(
      `INSERT INTO memory_audit (id, tenant_id, created_at, operation)
       VALUES (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), '__unknown__', Date.now(), 'auth.jwt_invalid').run()
  } catch {
    // Best-effort audit — never crash on audit failure
  }
}
