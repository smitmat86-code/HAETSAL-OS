// src/workers/mcpagent/routes/auth.ts
// Auth route handlers — Google OAuth callback, token revocation
// Behind CF Access (user initiates from Pages UI)

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import { exchangeCodeForTokens, storeEncryptedTokens, revokeGoogleTokens } from '../../../services/google/oauth'
import { deriveTmk } from '../../../middleware/auth'

type Variables = { tenantId: string; jwtSub: string; traceId: string }
const auth = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * GET /auth/google/callback — OAuth code exchange
 * Behind CF Access — browser has active CF Access session cookie
 * Exchanges code → encrypts tokens → stores in KV
 */
auth.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const scope = c.req.query('scope') ?? 'gmail.readonly'
  if (!code) return c.json({ error: 'Missing code parameter' }, 400)

  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const redirectUri = new URL('/auth/google/callback', c.req.url).toString()

  const tokens = await exchangeCodeForTokens(code, redirectUri, c.env)
  const tmk = await deriveTmk(jwtSub, c.env.CF_ACCESS_AUD)
  await storeEncryptedTokens(tenantId, scope, tokens, tmk, c.env)

  return c.json({ status: 'connected', scope })
})

/**
 * POST /auth/google/revoke — clear Google tokens
 */
auth.post('/google/revoke', async (c) => {
  const tenantId = c.get('tenantId')
  const { scope } = await c.req.json<{ scope: string }>()
  await revokeGoogleTokens(tenantId, scope, c.env)
  return c.json({ status: 'revoked', scope })
})

export { auth }
