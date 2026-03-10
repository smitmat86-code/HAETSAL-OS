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
import { retainViaService } from '../../../tools/retain'
import { recallStub } from '../../../tools/recall'
import { sendMessageSchema, sendMessageStub } from '../../../tools/act/send-message'
import { createEventSchema, createEventStub } from '../../../tools/act/create-event'
import { modifyEventSchema, modifyEventStub } from '../../../tools/act/modify-event'
import { draftSchema, draftStub } from '../../../tools/act/draft'
import { searchSchema, searchStub } from '../../../tools/act/search'
import { browseSchema, browseStub } from '../../../tools/act/browse'
import { remindSchema, remindStub } from '../../../tools/act/remind'
import { runPlaybookSchema, runPlaybookStub } from '../../../tools/act/run-playbook'

export class McpAgentDO extends BaseMcpAgent<Env> {
  private tmk: CryptoKey | null = null
  private _tenantId: string | null = null
  private wsConnections: Set<WebSocket> = new Set()

  server = new McpServer({ name: 'the-brain', version: '2.1.0' })

  async init() {
    this.registerMemoryTools()
    this.registerActTools()
  }

  private registerMemoryTools() {
    const doEnv = this.env
    const self = this
    this.server.tool('brain_v1_retain', 'Retain a memory in THE Brain', retainSchema,
      async (input) => {
        const typedInput = input as unknown as RetainInput
        const result = await retainViaService(typedInput, self._tenantId!, self.tmk, doEnv)
        if (self._tenantId) {
          self.ctx.waitUntil(writeAuditLog(doEnv, 'memory.retained', self._tenantId, {
            agentIdentity: 'mcpagent/tool',
          }))
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
    this.server.tool('brain_v1_recall', 'Recall memories from THE Brain', recallSchema,
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

  // Register action tool stubs — each publishes to QUEUE_ACTIONS
  // LESSON (1.2): McpServer.tool() requires ZodRawShapeCompat — pass schema.shape
  private registerActTools() {
    const doEnv = this.env
    const self = this
    const proposedBy = 'mcpagent/tool'
    const wrap = (fn: (i: unknown) => Promise<{ action_id: string; status: string }>) =>
      async (input: unknown) => {
        const result = await fn(input)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      }

    this.server.tool('brain_v1_act_send_message', 'Send SMS or email',
      sendMessageSchema.shape, wrap(i => sendMessageStub(
        i as Parameters<typeof sendMessageStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_create_event', 'Create calendar event',
      createEventSchema.shape, wrap(i => createEventStub(
        i as Parameters<typeof createEventStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_modify_event', 'Modify calendar event',
      modifyEventSchema.shape, wrap(i => modifyEventStub(
        i as Parameters<typeof modifyEventStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_draft', 'Create a draft',
      draftSchema.shape, wrap(i => draftStub(
        i as Parameters<typeof draftStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_search', 'Search the web',
      searchSchema.shape, wrap(i => searchStub(
        i as Parameters<typeof searchStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_browse', 'Browse a web page',
      browseSchema.shape, wrap(i => browseStub(
        i as Parameters<typeof browseStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_remind', 'Set a reminder',
      remindSchema.shape, wrap(i => remindStub(
        i as Parameters<typeof remindStub>[0], doEnv, self._tenantId!, proposedBy)))

    this.server.tool('brain_v1_act_run_playbook', 'Run a multi-step playbook',
      runPlaybookSchema.shape, wrap(i => runPlaybookStub(
        i as Parameters<typeof runPlaybookStub>[0], doEnv, self._tenantId!, proposedBy)))
  }

  async initTenant(jwtSub: string, tenantId: string) {
    this._tenantId = tenantId
    this.tmk = await deriveTmk(jwtSub, this.env.CF_ACCESS_AUD)
    const { tenant } = await getOrCreateTenant(tenantId, jwtSub, this.env)
    await provisionOrRenewKek(tenant, this.tmk, this.env)
  }

  // LESSON: WebSocket 101 headers are immutable in workerd
  async handleWebSocket(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    this.wsConnections.add(server)
    server.addEventListener('message', () => { /* Ping/pong — action events via broadcast */ })
    server.addEventListener('close', () => { this.wsConnections.delete(server) })
    server.send(JSON.stringify({ type: 'connected', tenantId: this._tenantId }))
    return new Response(null, { status: 101, webSocket: client })
  }

  broadcast(message: unknown) {
    const payload = JSON.stringify(message)
    for (const ws of this.wsConnections) {
      try { ws.send(payload) } catch { this.wsConnections.delete(ws) }
    }
  }

  // DO RPC methods for ingestion queue consumer (Phase 2.1)
  // Returns TMK if DO is warm (tenant authenticated), null if cold
  getTmk(): CryptoKey | null {
    return this.tmk
  }

  // Returns Hindsight tenant ID for this DO's tenant
  getHindsightTenantId(): string | null {
    return this._tenantId
  }
}
