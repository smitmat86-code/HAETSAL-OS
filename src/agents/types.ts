// src/agents/types.ts
// Agent system types — EpistemicMemoryType is the LAW 3 structural gate
// Procedural is deliberately excluded — only the nightly cron (3.3) can write it

/** Memory types agents are allowed to write — Law 3 structural enforcement */
export type EpistemicMemoryType = 'episodic' | 'semantic' | 'world'

/** Agent routing targets */
export type AgentType = 'chief_of_staff' | 'career_coach' | 'life_coach' | 'inline'

/** Loaded context for an agent session */
export interface AgentContext {
  memories: Array<{
    memory_id: string
    content: string
    memory_type: string
    confidence: number
    relevance: number
  }>
  pendingActions: Array<{
    id: string
    tool_name: string
    integration: string | null
    capability_class: string
    state: string
    proposed_at: number
  }>
  parentTraceId?: string
}

/** Per-run doom loop detection state */
export interface DoomLoopState {
  calls: Array<{ toolName: string; inputHash: string }>
  warnCount: number
}

/** Timestamped reasoning trace entry for R2 archive */
export interface ReasoningTraceEntry {
  timestamp: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  tokenCount?: number
}

/** Full reasoning trace written to R2 at close() */
export interface ReasoningTrace {
  traceId: string
  parentTraceId?: string
  agentIdentity: string
  domain: string
  tenantId: string
  startedAt: number
  endedAt?: number
  entries: ReasoningTraceEntry[]
  totalTokens: number
  doomLoopWarnings: number
  contextFlushes: number
}

/** Delegation signal from Chief of Staff */
export interface DelegationSignal {
  delegateTo: AgentType
  reason: string
  context: string
}

/** Career Coach extended context */
export interface CareerContext extends AgentContext {
  careerRelationships: AgentContext['memories']
  recentDecisions: AgentContext['memories']
}
