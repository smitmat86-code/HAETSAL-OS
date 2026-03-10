// src/agents/career-coach.ts — First domain agent on BaseAgent
// Career-specific memory loads at open(), structured synthesis at close()
// Law 3 inherited: retain() only accepts EpistemicMemoryType

import { BaseAgent } from './base-agent'
import type { Env } from '../types/env'
import type { CareerContext } from './types'
import { recallViaService } from '../tools/recall'

export class CareerCoach extends BaseAgent {
  readonly domain = 'career'
  readonly agentIdentity = 'career_coach'
  protected context: CareerContext = {
    memories: [], pendingActions: [],
    careerRelationships: [], recentDecisions: [],
  }
  private sessionTopics: string[] = []
  private sessionProposedActions: string[] = []
  private sessionKeyInsight: string = ''

  constructor(env: Env, tenantId: string, tmk: CryptoKey, hindsightTenantId: string) {
    super(env, tenantId, tmk, hindsightTenantId)
  }

  protected async open(): Promise<void> {
    await super.open()
    const relationships = await recallViaService(
      { query: 'professional relationships colleagues managers clients', domain: 'career', limit: 8 },
      this.hindsightTenantId, this.tmk, this.env,
    )
    const decisions = await recallViaService(
      { query: 'career decisions commitments agreed', domain: 'career', limit: 5 },
      this.hindsightTenantId, this.tmk, this.env,
    )
    this.context.careerRelationships = relationships.results
    this.context.recentDecisions = decisions.results
  }

  protected systemPrompt(): string {
    return `You are THE Brain's Career Coach — a trusted advisor on professional growth, work challenges, and career strategy.

Current context (loaded at session open):
${this.contextSummary()}

Key professional relationships:
${this.context.careerRelationships.map(r => r.content.slice(0, 150)).join('\n') || 'None loaded yet'}

Recent career decisions:
${this.context.recentDecisions.map(d => d.content.slice(0, 150)).join('\n') || 'None loaded yet'}

Pending career actions: ${this.context.pendingActions.filter(a => a.capability_class !== 'READ').length} awaiting approval

Your approach:
- Listen first. Understand what's actually being asked before advising.
- Connect present situations to longer-term goals.
- Propose concrete next steps via brain_v1_act_* tools when appropriate.
- Surface relevant past decisions or patterns from memory when useful.

You write session memories about: decisions made, insights reached, actions proposed.
You do NOT write personality rules or behavioral patterns — the nightly process does that.

Domain: career | Trace: ${this.traceId}`
  }

  async run(input: string, traceId: string, parentTraceId?: string): Promise<string> {
    this.traceId = traceId
    this.parentTraceId = parentTraceId
    await this.open()
    this.sessionTopics = this.extractTopics(input)
    const response = await this.agentLoop(input)
    this.sessionKeyInsight = response.slice(0, 200)
    const synthesis = this.buildCareerSynthesis()
    await this.retain(synthesis, 'episodic', 'career', 'career_coach_session')
    await this.close(synthesis)
    return response
  }

  getCareerContext(): string {
    const goals = this.context.memories
      .filter(m => m.memory_type === 'semantic')
      .map(m => m.content.slice(0, 200))
    const rels = this.context.careerRelationships.map(r => r.content.slice(0, 200))
    return [
      goals.length ? `Career goals:\n${goals.join('\n')}` : 'No career goals loaded',
      rels.length ? `Key relationships:\n${rels.join('\n')}` : 'No relationships loaded',
    ].join('\n\n')
  }

  private buildCareerSynthesis(): string {
    return [
      `Career session — ${new Date().toISOString()}`,
      this.sessionTopics.length ? `Topics: ${this.sessionTopics.join(', ')}` : '',
      this.sessionProposedActions.length
        ? `Proposed actions: ${this.sessionProposedActions.join(', ')}` : '',
      this.sessionKeyInsight ? `Key insight: ${this.sessionKeyInsight}` : '',
    ].filter(Boolean).join('\n')
  }

  private extractTopics(input: string): string[] {
    const keywords = ['career', 'job', 'project', 'promotion', 'review', 'salary',
      'interview', 'deadline', 'client', 'manager', 'team', 'work']
    return keywords.filter(k => input.toLowerCase().includes(k))
  }
}
