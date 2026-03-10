// src/workers/mcpagent/routes/auth.ts
// Auth route handlers — Google OAuth callback, token revocation
// Populated in Phase 2.2 with Google OAuth flow

import { Hono } from 'hono'
import type { Env } from '../../../types/env'

type Variables = { tenantId: string; jwtSub: string; traceId: string }
const auth = new Hono<{ Bindings: Env; Variables: Variables }>()

// TODO: Phase 2.2 — GET /callback (Google OAuth code exchange)
// TODO: Phase 2.2 — POST /revoke (clear Google tokens)

export { auth }
