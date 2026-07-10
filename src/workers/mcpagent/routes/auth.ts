// src/workers/mcpagent/routes/auth.ts
// Auth route handlers — Google OAuth callback, token revocation
// Behind CF Access (user initiates from Pages UI)

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import {
  buildGoogleAuthorizationUrl,
  exchangeCodeForTokens,
  storeGoogleGrant,
  revokeGoogleTokens,
} from '../../../services/google/oauth'
import { deriveTmk } from '../../../middleware/auth'
import type { IngestionQueueMessage } from '../../../types/ingestion'

type Variables = { tenantId: string; jwtSub: string; traceId: string }
const auth = new Hono<{ Bindings: Env; Variables: Variables }>()

auth.get('/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: 'Google OAuth is not configured' }, 503)
  }
  const state = crypto.randomUUID()
  await c.env.KV_SESSION.put(
    `google_oauth_state:${c.get('tenantId')}:${state}`,
    c.get('jwtSub'),
    { expirationTtl: 600 },
  )
  const redirectUri = new URL('/auth/google/callback', c.req.url).toString()
  return c.redirect(buildGoogleAuthorizationUrl(c.env.GOOGLE_CLIENT_ID, redirectUri, state))
})

/**
 * GET /auth/google/callback — OAuth code exchange
 * Behind CF Access — browser has active CF Access session cookie
 * Exchanges code → encrypts tokens → stores in KV
 */
auth.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const oauthError = c.req.query('error')
  if (oauthError) return c.json({ error: `Google authorization failed: ${oauthError}` }, 400)
  if (!code) return c.json({ error: 'Missing code parameter' }, 400)
  if (!state) return c.json({ error: 'Missing OAuth state' }, 400)

  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const stateKey = `google_oauth_state:${tenantId}:${state}`
  const expectedSub = await c.env.KV_SESSION.get(stateKey)
  await c.env.KV_SESSION.delete(stateKey)
  if (!expectedSub || expectedSub !== jwtSub) {
    return c.json({ error: 'Invalid or expired OAuth state' }, 400)
  }
  const redirectUri = new URL('/auth/google/callback', c.req.url).toString()

  const tokens = await exchangeCodeForTokens(code, redirectUri, c.env)
  const tmk = await deriveTmk(jwtSub, c.env.CF_ACCESS_AUD)
  await storeGoogleGrant(tenantId, tokens, tmk, c.env)

  const now = Date.now()
  const syncMessages: IngestionQueueMessage[] = [
    { type: 'gmail_thread', tenantId, payload: { maxThreads: 10 }, enqueuedAt: now },
    {
      type: 'calendar_event', tenantId,
      payload: { updatedSinceMs: now - 24 * 60 * 60 * 1000, maxEvents: 10 },
      enqueuedAt: now,
    },
  ]
  await c.env.QUEUE_NORMAL.sendBatch(syncMessages.map((body) => ({ body })))

  return c.html(`<!doctype html><html><head><title>Google connected</title></head>
<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;line-height:1.6">
<h1>Google connected</h1>
<p>Gmail and Calendar access is stored encrypted. A recent-source sync has started.</p>
<p><a href="/dashboard.html#connections">Return to HAETSAL</a></p>
</body></html>`)
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
