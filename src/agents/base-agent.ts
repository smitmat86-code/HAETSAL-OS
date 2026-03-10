// src/agents/base-agent.ts — Abstract BaseAgent: lifecycle, doom loop, context budget, Law 3
import type { Env } from '../types/env'
import type { IngestionArtifact } from '../types/ingestion'
import type {
  EpistemicMemoryType, AgentContext, DoomLoopState,
  ReasoningTrace, ReasoningTraceEntry,
} from './types'
import { retainContent } from '../services/ingestion/retain'
import { recallViaService } from '../tools/recall'
import {
  checkDoomLoop, encryptForR2, writeAnomalySignal,
  MODEL_CONTEXT_LIMIT, FLUSH_THRESHOLD,
} from './helpers'

export { checkDoomLoop } from './helpers'
export abstract class BaseAgent {
  abstract readonly domain: string
  abstract readonly agentIdentity: string
  protected env: Env
  protected tenantId: string
  protected tmk: CryptoKey
  protected hindsightTenantId: string
  protected traceId: string = ''
  protected parentTraceId?: string
  protected context: AgentContext = { memories: [], pendingActions: [] }
  protected reasoningTrace: ReasoningTrace
  private cumulativeTokens = 0
  private contextFlushes = 0

  constructor(env: Env, tenantId: string, tmk: CryptoKey, hindsightTenantId: string) {
    this.env = env
    this.tenantId = tenantId
    this.tmk = tmk
    this.hindsightTenantId = hindsightTenantId
    this.reasoningTrace = this.freshTrace()
  }

  protected async open(): Promise<void> {
    // Mental model from Hindsight API (plaintext — synthesized, no KEK needed)
    const mmRes = await this.env.HINDSIGHT.fetch(
      `http://hindsight/v1/default/banks/${this.hindsightTenantId}/mental-models/mental-model-${this.domain}`,
    )
    if (mmRes.ok) {
      const mm = await mmRes.json() as { content?: string }
      if (mm.content) this.context.memories.push({ content: mm.content, memory_type: 'semantic' })
    }
    const episodic = await recallViaService(
      { query: `recent events decisions ${this.domain}`, domain: this.domain, limit: 5 },
      this.hindsightTenantId, this.tmk, this.env,
    )
    this.context.memories = [...this.context.memories, ...episodic.results]
    const pending = await this.env.D1_US.prepare(
      `SELECT id, tool_name, integration, capability_class, state, proposed_at
       FROM pending_actions WHERE tenant_id = ? AND state IN ('awaiting_approval', 'queued')
       ORDER BY proposed_at DESC LIMIT 5`,
    ).bind(this.tenantId).all()
    this.context.pendingActions = pending.results as AgentContext['pendingActions']
  }

  protected async retain(
    content: string, memoryType: EpistemicMemoryType,
    domain: string, provenance: string,
  ): Promise<{ memoryId: string } | null> {
    const artifact: IngestionArtifact = {
      tenantId: this.tenantId, content, source: `agent:${this.agentIdentity}`,
      memoryType, domain, provenance, occurredAt: Date.now(),
    }
    const result = await retainContent(artifact, this.tmk, this.env, undefined)
    return result ? { memoryId: result.memoryId } : null
  }

  protected async agentLoop(input: string): Promise<string> {
    const doomState: DoomLoopState = { calls: [], warnCount: 0 }
    this.addTraceEntry('user', input)
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: input },
    ]
    for (let turn = 0; turn < 10; turn++) {
      const result = await this.callModel(messages)
      this.addTraceEntry('assistant', result.response)
      if (!result.toolCall) return result.response
      const loopCheck = await checkDoomLoop(doomState, result.toolCall.name, result.toolCall.input)
      if (loopCheck === 'break') {
        await writeAnomalySignal(this.env, this.tenantId, 'doom_loop_break', result.toolCall.name)
        return 'I appear to be stuck in a loop on this request. Could you rephrase or clarify?'
      }
      if (loopCheck === 'warn') {
        const n = doomState.calls.filter(c => c.toolName === result.toolCall!.name).length
        messages.push({ role: 'system',
          content: `[SYSTEM: You have called ${result.toolCall.name} with identical inputs ${n} times. Consider a different approach or ask the user for clarification.]`,
        })
      }
      messages.push({ role: 'assistant', content: result.response })
      if (this.cumulativeTokens / MODEL_CONTEXT_LIMIT > FLUSH_THRESHOLD) {
        await this.flushContext(messages)
        this.contextFlushes++
      }
    }
    return 'I was unable to complete this request within the allowed number of turns.'
  }

  private async callModel(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ response: string; toolCall?: { name: string; input: unknown } }> {
    const result = await this.env.AI.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as BaseAiTextGenerationModels,
      { messages: messages as RoleScopedChatInput[] },
      { gateway: { id: 'brain-gateway' } },
    ) as AiTextGenerationOutput & { usage?: { input_tokens: number; output_tokens: number } }
    const response = typeof result === 'string' ? result
      : (result as { response?: string }).response ?? ''
    if (result.usage) this.cumulativeTokens += result.usage.input_tokens + result.usage.output_tokens
    return { response }
  }

  private async flushContext(messages: Array<{ role: string; content: string }>): Promise<void> {
    const summary = messages.slice(-4).map(m => m.content.slice(0, 200)).join(' | ')
    await this.retain(`Session in progress: ${summary}`, 'episodic', this.domain, 'context_flush')
    messages.splice(1, messages.length - 2)
    this.cumulativeTokens = 0
  }

  protected async close(sessionSummary: string): Promise<void> {
    await this.retain(sessionSummary, 'episodic', this.domain, 'agent_session')
    this.reasoningTrace.endedAt = Date.now()
    this.reasoningTrace.totalTokens = this.cumulativeTokens
    this.reasoningTrace.doomLoopWarnings = 0
    this.reasoningTrace.contextFlushes = this.contextFlushes
    const encrypted = await encryptForR2(JSON.stringify(this.reasoningTrace), this.tmk)
    this.env.R2_OBSERVABILITY.put(`traces/${this.tenantId}/${this.traceId}`, encrypted).catch(() => {})
    this.context = { memories: [], pendingActions: [] }
  }

  private addTraceEntry(role: ReasoningTraceEntry['role'], content: string): void {
    this.reasoningTrace.entries.push({ timestamp: Date.now(), role, content: content.slice(0, 500) })
  }

  protected abstract systemPrompt(): string
  protected contextSummary(): string { return this.context.memories.map(m => m.content.slice(0, 200)).join('\n') }
  protected activeDomains(): string[] { return [...new Set(this.context.memories.map(m => m.memory_type))] }
  private freshTrace(): ReasoningTrace {
    return { traceId: '', agentIdentity: '', domain: '', tenantId: '',
      startedAt: Date.now(), entries: [], totalTokens: 0, doomLoopWarnings: 0, contextFlushes: 0 }
  }
}
