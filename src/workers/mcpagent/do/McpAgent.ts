import { McpAgent as BaseMcpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../../types/env'
import { deriveTenantId, deriveTmk } from '../../../middleware/auth'
import { getOrCreateTenant, provisionOrRenewKek } from '../../../services/tenant'
import { ensureHindsightWorkersRunning, prewarmHindsight } from '../../../services/hindsight'
import { registerBrainMemorySurface } from '../../../tools/brain-memory-surface'
import type { InterviewState } from '../../../types/bootstrap'
import { registerBootstrapTools } from '../../../tools/bootstrap'
import { registerMemoryTools } from '../../../tools/memory'
import { processInboundMessage } from './inbound-message'
import { registerActTools, registerLegacyMemoryTools } from './register-tools'
import { ensureSessionTable, readPersistedSession, writePersistedSession } from './session-store'

interface McpAgentProps extends Record<string, unknown> { tenantId?: string; jwtSub?: string }
export class McpAgentDO extends BaseMcpAgent<Env, unknown, McpAgentProps> {
  private tmk: CryptoKey | null = null
  private _tenantId: string | null = null
  private wsConnections: Set<WebSocket> = new Set()
  private interviewState: InterviewState | null = null
  server = new McpServer({ name: 'haetsal', version: '6.2.0' })

  async init() {
    this.ensureSessionTable()
    await this.hydrateSessionState()
    registerLegacyMemoryTools({
      env: this.env,
      server: this.server,
      getTenantId: () => this._tenantId!,
      getTmk: () => this.tmk,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    })
    registerActTools({ env: this.env, server: this.server, getTenantId: () => this._tenantId! })
    const ctx = { getEnv: () => this.env, getTenantId: () => this._tenantId!, getTmk: () => this.tmk, getHindsightTenantId: () => this._tenantId!,
      getExecutionContext: () => ({ waitUntil: this.ctx.waitUntil.bind(this.ctx) }) }
    registerBrainMemorySurface(this.server, ctx)
    registerMemoryTools(this.server, ctx)
    registerBootstrapTools(this.server, {
      getEnv: () => this.env, getTenantId: () => this._tenantId!,
      getTmk: () => this.tmk,
      getInterviewState: () => this.interviewState,
      setInterviewState: (s) => {
        this.interviewState = s
        this.persistSessionState({ interviewState: s })
      },
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

  private persistSessionState(update: {
    tenantId?: string | null
    jwtSub?: string | null
    interviewState?: InterviewState | null
  }): void {
    const current = readPersistedSession(this.sql.bind(this))
    const tenantId = update.tenantId ?? current?.tenant_id ?? this._tenantId
    const jwtSub = update.jwtSub ?? current?.jwt_sub ?? null
    writePersistedSession(this.sql.bind(this), {
      tenantId,
      jwtSub,
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
    this.ctx.waitUntil(prewarmHindsight(tenantId, this.env).catch(() => {}))
    this.ctx.waitUntil(ensureHindsightWorkersRunning(this.env).catch(() => {}))
  }
  private async ensureTenantContext(request: Request): Promise<void> {
    const propTenantId = typeof this.props?.tenantId === 'string' && this.props.tenantId.length > 0
      ? this.props.tenantId
      : null
    const propJwtSub = typeof this.props?.jwtSub === 'string' && this.props.jwtSub.length > 0
      ? this.props.jwtSub
      : null

    let tenantId = propTenantId ?? request.headers.get('x-brain-tenant-id')
    const jwtSub = propJwtSub ?? request.headers.get('x-brain-jwt-sub')

    if (!tenantId && jwtSub) {
      const [primaryAudience] = this.env.CF_ACCESS_AUD.split(',').map(s => s.trim()).filter(Boolean)
      if (primaryAudience) {
        tenantId = await deriveTenantId(jwtSub, primaryAudience)
      }
    }

    if (!tenantId || !jwtSub || (this._tenantId === tenantId && this.tmk)) return
    this.ensureSessionTable()
    await this.initTenant(jwtSub, tenantId)
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

  async fetch(request: Request): Promise<Response> {
    await this.ensureTenantContext(request)
    const url = new URL(request.url)
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request)
    }
    if (url.pathname === '/inbound' && request.method === 'POST') {
      const { tenantId, text, channel, replyTo } = await request.json() as {
        tenantId: string; text: string; channel: 'sms' | 'telegram'; replyTo: string
      }
      if (!this._tenantId) {
        this._tenantId = tenantId
        this.persistSessionState({ tenantId })
      }
      const result = await processInboundMessage(this.env, tenantId, text, channel, replyTo)
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
    }
    return super.fetch(request)
  }
}
