// src/workers/mcpagent/do/McpAgent.ts — DO session container, TMK in memory
import { McpAgent as BaseMcpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../../types/env'
import type { RetainInput, RecallInput } from '../../../types/tools'
import { retainSchema, recallSchema } from '../../../types/tools'
import { deriveTmk } from '../../../middleware/auth'
import { writeAuditLog } from '../../../middleware/audit'
import { getOrCreateTenant, provisionOrRenewKek } from '../../../services/tenant'
import { retainViaService } from '../../../tools/retain'
import { recallViaService } from '../../../tools/recall'
import { sendMessageSchema, sendMessageStub } from '../../../tools/act/send-message'
import { createEventSchema, createEventStub } from '../../../tools/act/create-event'
import { modifyEventSchema, modifyEventStub } from '../../../tools/act/modify-event'
import { draftSchema, draftStub } from '../../../tools/act/draft'
import { searchSchema, searchStub } from '../../../tools/act/search'
import { browseSchema, browseStub } from '../../../tools/act/browse'
import { remindSchema, remindStub } from '../../../tools/act/remind'
import { runPlaybookSchema, runPlaybookStub } from '../../../tools/act/run-playbook'
import type { InterviewState } from '../../../types/bootstrap'
import { registerBootstrapTools } from '../../../tools/bootstrap'
import { registerMemoryTools } from '../../../tools/memory'

export class McpAgentDO extends BaseMcpAgent<Env> {
  private tmk: CryptoKey | null = null
  private _tenantId: string | null = null
  private wsConnections: Set<WebSocket> = new Set()
  private interviewState: InterviewState | null = null
  server = new McpServer({ name: 'the-brain', version: '3.2.0' })

  async init() {
    this.registerLegacyMemoryTools()
    this.registerActTools()
    const ctx = { getEnv: () => this.env, getTenantId: () => this._tenantId!,
      getTmk: () => this.tmk, getHindsightTenantId: () => this._tenantId! }
    registerMemoryTools(this.server, ctx)
    registerBootstrapTools(this.server, {
      getEnv: () => this.env, getTenantId: () => this._tenantId!,
      getTmk: () => this.tmk,
      getInterviewState: () => this.interviewState,
      setInterviewState: (s) => { this.interviewState = s },
    })
  }

  private registerLegacyMemoryTools() {
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
        const typedInput = input as unknown as RecallInput
        const result = await recallViaService(typedInput, self._tenantId!, self.tmk, doEnv)
        if (self._tenantId) {
          self.ctx.waitUntil(writeAuditLog(doEnv, 'memory.recalled', self._tenantId, {
            agentIdentity: 'mcpagent/tool',
          }))
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
  }

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

  async handleWebSocket(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    this.wsConnections.add(server)
    server.addEventListener('message', () => {})
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

  getTmk(): CryptoKey | null { return this.tmk }
  getHindsightTenantId(): string | null { return this._tenantId }
}
