import { McpAgent as BaseMcpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../../types/env'
import { deriveTmk } from '../../../middleware/auth'
import { getOrCreateTenant, provisionOrRenewKek } from '../../../services/tenant'
import type { InterviewState } from '../../../types/bootstrap'
import { handleInboundPost } from './inbound-message'
import { registerAllDoTools } from './register-tools'
import { ensureSessionTable, readPersistedSession, writePersistedSession } from './session-store'
import { closeWorkingSession, recordExchange, sessionWindowBlock, type SessionHost } from './session-runtime'
import { deliverReminder, scheduleReminder, type ReminderSchedulePayload } from './action-scheduling'
import { acceptSessionWebSocket, broadcastToSessions, resolveTenantContext } from './tenant-context'
import { dispatchExecutionTask, handleExecutionTaskFinish, type ExecutionTaskSpec } from './agent-dispatch'
import { cancelAgentRun, listAgentRuns, retryAgentRun, type RunsHost } from './agent-runs-view'
import {
  createAutomation, fireAutomationTick, removeAutomation, toggleAutomation,
  type AutomationHost, type AutomationView, type CreateAutomationInput,
} from './automation-runtime'
import { listAutomationsView } from './automation-view'
import type { AgentRunView } from '../../../agents/execution/types'
interface McpAgentProps extends Record<string, unknown> {
  tenantId?: string; jwtSub?: string; clientName?: string | null; agentIdentity?: string | null; actorKind?: 'human' | 'service'
}
export class McpAgentDO extends BaseMcpAgent<Env, unknown, McpAgentProps> {
  private tmk: CryptoKey | null = null
  private _tenantId: string | null = null
  private wsConnections: Set<WebSocket> = new Set()
  private interviewState: InterviewState | null = null
  server = new McpServer({ name: 'haetsal', version: '6.2.0' })
  async init() {
    this.ensureSessionTable()
    await this.hydrateSessionState()
    registerAllDoTools({
      env: this.env, server: this.server,
      getTenantId: () => this._tenantId!, getTmk: () => this.tmk,
      getClientIdentity: () => ({
        clientName: typeof this.props?.clientName === 'string' ? this.props.clientName : this.props?.actorKind === 'human' ? 'ChatGPT' : null,
        agentIdentity: typeof this.props?.agentIdentity === 'string' ? this.props.agentIdentity : this.props?.actorKind === 'human' ? 'chatgpt-developer-mode' : null,
      }),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      getInterviewState: () => this.interviewState,
      setInterviewState: (s) => { this.interviewState = s; this.persistSessionState({ interviewState: s }) },
      getAutomationHost: () => this.automationHost(),
    })
  }

  private ensureSessionTable(): void { ensureSessionTable(this.sql.bind(this)) }

  private async hydrateSessionState(): Promise<void> {
    const row = readPersistedSession(this.sql.bind(this))
    if (!row) return
    this._tenantId = row.tenant_id
    this.interviewState = row.interview_state ? JSON.parse(row.interview_state) as InterviewState : null
    if (!this.tmk && row.jwt_sub) {
      this.tmk = await deriveTmk(row.jwt_sub, this.env.CF_ACCESS_AUD)
    }
  }

  private persistSessionState(update: { tenantId?: string | null; jwtSub?: string | null; interviewState?: InterviewState | null }): void {
    const current = readPersistedSession(this.sql.bind(this))
    writePersistedSession(this.sql.bind(this), {
      tenantId: update.tenantId ?? current?.tenant_id ?? this._tenantId,
      jwtSub: update.jwtSub ?? current?.jwt_sub ?? null,
      interviewState: update.interviewState ?? this.interviewState,
    })
  }

  async initTenant(jwtSub: string, tenantId: string) {
    this.ensureSessionTable()
    this._tenantId = tenantId
    this.tmk = await deriveTmk(jwtSub, this.env.CF_ACCESS_AUD)
    this.persistSessionState({ tenantId, jwtSub })
    const { tenant } = await getOrCreateTenant(tenantId, jwtSub, this.env)
    await provisionOrRenewKek(tenant, this.tmk, this.env)
  }

  private async ensureTenantContext(request: Request): Promise<void> {
    const resolved = await resolveTenantContext(this.props, request, this.env.CF_ACCESS_AUD)
    if (!resolved || (this._tenantId === resolved.tenantId && this.tmk)) return
    this.ensureSessionTable()
    await this.initTenant(resolved.jwtSub, resolved.tenantId)
  }

  broadcast(message: unknown) { broadcastToSessions(this.wsConnections, message) }

  getTmk(): CryptoKey | null { return this.tmk }

  // act_remind (Phase 5): schedule + fire via the Agents SDK alarm scheduler.
  async scheduleReminder(remindAtMs: number, message: string, channel?: string): Promise<{ scheduledFor: number }> {
    if (!this.tmk) throw new Error('TMK unavailable — reminder cannot be scheduled')
    return scheduleReminder(this.schedule.bind(this) as never, this.tmk, remindAtMs, message, channel)
  }
  async fireReminder(payload: ReminderSchedulePayload): Promise<void> {
    if (this.tmk && this._tenantId) await deliverReminder(this.env, this._tenantId, this.tmk, payload)
  }

  // Phase 6: sub-agent spawn + cancel/retry (native runAgentTool on ExecutionAgent facets).
  private runsHost(): RunsHost {
    return {
      env: this.env, sql: this.sql.bind(this) as RunsHost['sql'],
      tenantId: this._tenantId, tmk: this.tmk,
      jwtSub: readPersistedSession(this.sql.bind(this))?.jwt_sub ?? null,
      runAgentTool: (cls, opts) => this.runAgentTool(cls, opts) as Promise<{ runId: string; status: string; error?: string }>,
      cancelAgentTool: (runId, reason) => this.cancelAgentTool(runId, reason),
      subAgent: (cls, name) => this.subAgent(cls, name) as ReturnType<RunsHost['subAgent']>,
    }
  }
  async dispatchExecutionTask(spec: ExecutionTaskSpec): Promise<{ runId: string }> { return dispatchExecutionTask(this.runsHost(), spec) }
  async onExecutionTaskFinish(run: { runId: string; status: string }, lifecycle: { status: string; error?: string }): Promise<void> { await handleExecutionTaskFinish(this.runsHost(), run, lifecycle) }
  async listAgentRuns(limit?: number): Promise<AgentRunView[]> { return listAgentRuns(this.runsHost(), limit) }
  async cancelAgentRun(runId: string): Promise<{ cancelled: boolean }> { return cancelAgentRun(this.runsHost(), runId) }
  async retryAgentRun(runId: string): Promise<{ runId: string }> { return retryAgentRun(this.runsHost(), runId) }

  // Phase 7: user automations (tz-correct one-shot alarms that re-arm on fire).
  private automationHost(): AutomationHost {
    return { ...this.runsHost(),
      schedule: (when, callback, payload) => this.schedule(when, callback as never, payload),
      cancelSchedule: (id) => this.cancelSchedule(id) }
  }
  async fireAutomation(payload: { automationId: string }): Promise<void> { await fireAutomationTick(this.automationHost(), payload) }

  // Phase 9: working-session context (encrypted window; evidence on close).
  private sessionHost(): SessionHost { return this.automationHost() }
  async recordSessionExchange(sessionKey: string, userText: string, assistantText: string): Promise<{ recorded: boolean }> { return recordExchange(this.sessionHost(), sessionKey, userText, assistantText) }
  async getSessionWindowBlock(sessionKey: string): Promise<string> { return sessionWindowBlock(this.sessionHost(), sessionKey) }
  async closeIdleSession(payload: { sessionKey: string }): Promise<void> { await closeWorkingSession(this.sessionHost(), payload.sessionKey) }
  async closeSessionRpc(sessionKey: string): Promise<{ closed: boolean }> { return closeWorkingSession(this.sessionHost(), sessionKey) }
  async createAutomationRpc(input: CreateAutomationInput): Promise<{ id: string; description: string }> { return createAutomation(this.automationHost(), input) }
  async listAutomationsRpc(): Promise<AutomationView[]> { return listAutomationsView(this.automationHost()) }
  async toggleAutomationRpc(idPrefix: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> { return toggleAutomation(this.automationHost(), idPrefix, enabled) }
  async deleteAutomationRpc(idPrefix: string): Promise<{ id: string }> { return removeAutomation(this.automationHost(), idPrefix) }

  async fetch(request: Request): Promise<Response> {
    await this.ensureTenantContext(request)
    const url = new URL(request.url)
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return acceptSessionWebSocket(this.wsConnections, this._tenantId)
    }
    if (url.pathname === '/inbound' && request.method === 'POST') {
      return handleInboundPost(request, this.env, (tenantId) => {
        if (!this._tenantId) {
          this._tenantId = tenantId
          this.persistSessionState({ tenantId })
        }
      })
    }
    return super.fetch(request)
  }
}
