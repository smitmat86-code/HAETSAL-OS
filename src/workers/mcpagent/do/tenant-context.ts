// src/workers/mcpagent/do/tenant-context.ts
// Request → tenant identity resolution for the DO fetch path, extracted from
// McpAgent.ts for the file line limit. Behavior-preserving: props win over
// headers; tenant id derives from jwtSub when absent.

import { deriveTenantId } from '../../../middleware/auth'

export interface ResolvedTenantContext {
  tenantId: string
  jwtSub: string
}

export async function resolveTenantContext(
  props: { tenantId?: unknown; jwtSub?: unknown } | undefined,
  request: Request,
  cfAccessAud: string,
): Promise<ResolvedTenantContext | null> {
  const propTenantId = typeof props?.tenantId === 'string' && props.tenantId.length > 0
    ? props.tenantId
    : null
  const propJwtSub = typeof props?.jwtSub === 'string' && props.jwtSub.length > 0
    ? props.jwtSub
    : null

  let tenantId = propTenantId ?? request.headers.get('x-brain-tenant-id')
  const jwtSub = propJwtSub ?? request.headers.get('x-brain-jwt-sub')

  if (!tenantId && jwtSub) {
    const [primaryAudience] = cfAccessAud.split(',').map(s => s.trim()).filter(Boolean)
    if (primaryAudience) {
      tenantId = await deriveTenantId(jwtSub, primaryAudience)
    }
  }
  if (!tenantId || !jwtSub) return null
  return { tenantId, jwtSub }
}

/** WebSocket hub helpers (moved with the extraction for the same line limit). */
export function acceptSessionWebSocket(
  connections: Set<WebSocket>,
  tenantId: string | null,
): Response {
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  connections.add(server)
  server.addEventListener('message', () => {})
  server.addEventListener('close', () => { connections.delete(server) })
  server.send(JSON.stringify({ type: 'connected', tenantId }))
  return new Response(null, { status: 101, webSocket: client })
}

export function broadcastToSessions(connections: Set<WebSocket>, message: unknown): void {
  const payload = JSON.stringify(message)
  for (const ws of connections) {
    try { ws.send(payload) } catch { connections.delete(ws) }
  }
}
