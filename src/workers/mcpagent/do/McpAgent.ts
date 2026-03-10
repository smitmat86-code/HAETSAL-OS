// src/workers/mcpagent/do/McpAgent.ts
// THE Brain's session container — Durable Object
// Holds TMK in memory — eviction = key rotation
// Handles MCP Streamable HTTP + WebSocket upgrade for Pages push

import { McpAgent as BaseMcpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../../types/env'
import type { RetainInput, RecallInput } from '../../../types/tools'
import { retainSchema, recallSchema } from '../../../types/tools'
import { deriveTmk } from '../../../middleware/auth'
import { writeAuditLog } from '../../../middleware/audit'
import { getOrCreateTenant, provisionOrRenewKek } from '../../../services/tenant'
import { retainStub } from '../../../tools/retain'
import { recallStub } from '../../../tools/recall'

export class McpAgentDO extends BaseMcpAgent<Env> {
  // TMK held in DO memory only — NEVER written to storage
  // Eviction clears it — re-derived on next auth
  private tmk: CryptoKey | null = null
  private _tenantId: string | null = null
  private wsConnections: Set<WebSocket> = new Set()

  server = new McpServer({
    name: 'the-brain',
    version: '1.2.0',
  })

  async init() {
    const doEnv = this.env
    const self = this

    // Register MCP tools
    this.server.tool(
      'brain_v1_retain',
      'Retain a memory in THE Brain',
      retainSchema,
      async (input) => {
        const result = await retainStub(input as unknown as RetainInput)
        // Audit via waitUntil — do not block MCP response
        if (self._tenantId) {
          self.ctx.waitUntil(writeAuditLog(doEnv, 'memory.retain_stub', self._tenantId, {
            agentIdentity: 'mcpagent/stub',
          }))
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )

    this.server.tool(
      'brain_v1_recall',
      'Recall memories from THE Brain',
      recallSchema,
      async (input) => {
        const result = await recallStub(input as unknown as RecallInput)
        if (self._tenantId) {
          self.ctx.waitUntil(writeAuditLog(doEnv, 'memory.recall_stub', self._tenantId, {
            agentIdentity: 'mcpagent/stub',
          }))
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
  }

  // Initialize tenant context — called by Worker via DO RPC after auth
  async initTenant(jwtSub: string, tenantId: string) {
    this._tenantId = tenantId
    this.tmk = await deriveTmk(jwtSub, this.env.CF_ACCESS_AUD)
    const { tenant } = await getOrCreateTenant(tenantId, jwtSub, this.env)
    await provisionOrRenewKek(tenant, this.tmk, this.env)
  }

  // WebSocket upgrade handler — Pages UI push (1.3+ will broadcast action events)
  // LESSON: WebSocket 101 headers are immutable in workerd
  async handleWebSocket(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    this.wsConnections.add(server)

    server.addEventListener('message', () => {
      // Ping/pong only in Phase 1 — action events wired in 1.3
    })
    server.addEventListener('close', () => {
      this.wsConnections.delete(server)
    })

    // Send connected confirmation
    server.send(JSON.stringify({ type: 'connected', tenantId: this._tenantId }))

    return new Response(null, { status: 101, webSocket: client })
  }

  // Broadcast to all connected Pages clients — called by Action Worker in 1.3
  broadcast(message: unknown) {
    const payload = JSON.stringify(message)
    for (const ws of this.wsConnections) {
      try { ws.send(payload) } catch { this.wsConnections.delete(ws) }
    }
  }
}
