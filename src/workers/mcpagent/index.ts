// src/workers/mcpagent/index.ts
// Hono app — route registrations only
// Middleware order: security headers → auth → audit → dlp (MCP routes) → handler
// LESSON: Security headers in try/finally — skip on WebSocket 101 responses

import { Hono } from 'hono'
import { McpAgentDO } from './do/McpAgent'
import { authMiddleware } from '../../middleware/auth'
import { auditMiddleware } from '../../middleware/audit'
import { dlpMiddleware } from '../../middleware/dlp'
import type { Env } from '../../types/env'

type Variables = {
  tenantId: string
  jwtSub: string
  traceId: string
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Security headers — skip on WebSocket 101 (immutable in workerd)
// LESSON: WebSocket 101 headers are immutable — mutating throws TypeError
app.use('*', async (c, next) => {
  const isWebSocket = c.req.header('Upgrade') === 'websocket'
  try {
    await next()
  } finally {
    if (!isWebSocket && c.res) {
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('X-Frame-Options', 'DENY')
      c.header('Referrer-Policy', 'no-referrer')
    }
  }
})

// Auth on all routes — Law 1: no route bypasses JWT validation
app.use('*', authMiddleware())

// Audit on all routes (stamps traceId after auth)
app.use('*', auditMiddleware())

// DLP only on MCP routes
app.use('/mcp/*', dlpMiddleware())
app.use('/mcp', dlpMiddleware())

// MCP Streamable HTTP — delegate to DO
app.all('/mcp', async (c) => {
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const id = c.env.MCPAGENT.idFromName(tenantId)
  const stub = c.env.MCPAGENT.get(id)
  // @ts-expect-error -- DO RPC method not in generic DurableObjectStub type
  await stub.initTenant(jwtSub, tenantId)
  return stub.fetch(c.req.raw)
})

// WebSocket upgrade — delegate to DO
// LESSON: Use new Request(url, c.req.raw) to preserve upgrade semantics
app.get('/ws', async (c) => {
  const tenantId = c.get('tenantId')
  const jwtSub = c.get('jwtSub')
  const id = c.env.MCPAGENT.idFromName(tenantId)
  const stub = c.env.MCPAGENT.get(id)
  // @ts-expect-error -- DO RPC method not in generic DurableObjectStub type
  await stub.initTenant(jwtSub, tenantId)
  // @ts-expect-error -- handleWebSocket is a DO RPC method
  return stub.handleWebSocket(new Request(c.req.url, c.req.raw))
})

export { McpAgentDO }
export default app
