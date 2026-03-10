// tests/test-entry.ts
// Minimal worker entry for vitest-pool-workers
// Does not import the McpAgent DO (agents SDK has bundling issues in miniflare)
// The actual McpAgent DO is tested via unit tests on its components
// This entry provides the Hono app + middleware chain for integration testing

import { Hono } from 'hono'
import { authMiddleware } from '../src/middleware/auth'
import { auditMiddleware } from '../src/middleware/audit'
import { dlpMiddleware } from '../src/middleware/dlp'
import type { Env } from '../src/types/env'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Security headers — skip on WebSocket 101
app.use('*', async (c, next) => {
  const isWebSocket = c.req.header('Upgrade') === 'websocket'
  try { await next() } finally {
    if (!isWebSocket && c.res) {
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('X-Frame-Options', 'DENY')
      c.header('Referrer-Policy', 'no-referrer')
    }
  }
})

app.use('*', authMiddleware())
app.use('*', auditMiddleware())
app.use('/mcp/*', dlpMiddleware())
app.use('/mcp', dlpMiddleware())

// Stub routes for testing middleware chain
app.all('/mcp', (c) => c.json({ status: 'mcp_ok', tenantId: c.get('tenantId') }))
app.get('/ws', (c) => c.json({ status: 'ws_ok', tenantId: c.get('tenantId') }))

export default app
