// src/agents/chief-of-staff.ts
// Layer 2 orchestrator — full context, delegates or handles directly
// parent_trace_id chaining for causal tracing across agent calls

import { BaseAgent } from './base-agent'
import type { Env } from '../types/env'
import type { DelegationSignal } from './types'

export class ChiefOfStaff extends BaseAgent {
  readonly domain = 'general'
  readonly agentIdentity = 'chief_of_staff'

  constructor(env: Env, tenantId: string, tmk: CryptoKey, hindsightTenantId: string) {
    super(env, tenantId, tmk, hindsightTenantId)
  }

  protected systemPrompt(): string {
    return `You are THE Brain's Chief of Staff — the tenant's most trusted advisor.
You have full context of their goals, pending decisions, and active projects.
You orchestrate other agents, propose actions, and maintain strategic continuity.

Current context (loaded at session open):
${this.contextSummary()}

Pending actions awaiting approval: ${this.context.pendingActions.length}
Active domains: ${this.activeDomains().join(', ')}

You can:
- Answer questions directly using loaded memory context
- Propose actions via brain_v1_act_* tools (they go through authorization gate)
- Delegate to domain agents by including a delegation signal in your response
- Surface connections between domains that the tenant may not have noticed

You cannot:
- Write procedural memories (only the nightly cron can)
- Access raw action payloads (Law 2)
- Bypass the authorization gate`
  }

  async run(input: string, traceId: string, parentTraceId?: string): Promise<string> {
    this.traceId = traceId
    this.parentTraceId = parentTraceId

    await this.open()

    const response = await this.agentLoop(input)

    const synthesis = `Chief of Staff session: ${input.slice(0, 100)}... -> ${response.slice(0, 100)}...`
    await this.close(synthesis)

    return response
  }

  /** Detect delegation signal in agent response (Phase 3.1: signal only, not programmatic) */
  parseDelegation(response: string): DelegationSignal | null {
    try {
      const match = response.match(/\[DELEGATE:(\w+)\|(.+?)\|(.+?)\]/)
      if (!match) return null
      return {
        delegateTo: match[1] as DelegationSignal['delegateTo'],
        reason: match[2],
        context: match[3],
      }
    } catch {
      return null
    }
  }
}
