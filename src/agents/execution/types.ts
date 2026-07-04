// src/agents/execution/types.ts
// Phase 6 execution-agent types. The task input crosses the parent→facet RPC
// in memory only; anything persisted (run rows, ledger output) is either
// TMK-encrypted ciphertext or drawn from the content-free vocabulary here.

/** Tool scopes an execution agent can be spawned with (per-spawn scoping). */
export type ExecutionProfile = 'research' | 'memory' | 'comms' | 'general'

/** Registry tool names — the only values that may appear in previews/progress. */
export type ExecutionToolName =
  | 'web_search'
  | 'recall_memory'
  | 'propose_message'
  | 'propose_draft'
  | 'propose_reminder'

/** Profile → allowed tool subset. The parent resolves this at dispatch time;
 *  the child enforces it structurally (out-of-scope calls never execute). */
export const PROFILE_TOOLS: Record<ExecutionProfile, ExecutionToolName[]> = {
  research: ['web_search', 'recall_memory'],
  memory: ['recall_memory'],
  comms: ['recall_memory', 'propose_message', 'propose_draft', 'propose_reminder'],
  general: ['web_search', 'recall_memory', 'propose_message', 'propose_draft', 'propose_reminder'],
}

/** RPC input for ExecutionAgent.startAgentToolRun. Plaintext task text lives
 *  only in memory during the run — never persisted unencrypted. */
export interface ExecutionTaskInput {
  tenantId: string
  /** CF Access subject — the child re-derives the TMK from this, exactly as
   *  initTenant does, so ciphertexts interoperate with the parent's TMK. */
  jwtSub: string
  task: string
  contextNote?: string
  profile: ExecutionProfile
  allowedTools: ExecutionToolName[]
  maxTurns?: number
  /** Soft in-loop deadline; the parent's detached maxBudgetMs is the hard one. */
  deadlineMs?: number
}

/** Content-free progress snapshot persisted per run (drives heartbeat). */
export interface ExecutionProgress {
  fraction: number
  phase: string
  at: number
}

/** What the loop returns to the adapter (plaintext; adapter encrypts). */
export interface ExecutionLoopResult {
  status: 'completed' | 'aborted'
  resultText: string
  turns: number
  toolCalls: number
  toolsUsed: ExecutionToolName[]
}

/** Encrypted output stored in the parent ledger (cf_agent_tool_runs.output_json).
 *  Law 2: nothing but ciphertext + content-free counters in this shape. */
export interface ExecutionRunOutput {
  ciphertext: string
  turns: number
  toolCalls: number
  toolsUsed: string[]
}

/** Dashboard-facing run view — every field content-free. */
export interface AgentRunView {
  runId: string
  agentType: string
  profile: string | null
  tools: string[]
  status: string
  progress: ExecutionProgress | null
  heartbeatAgeMs: number | null
  startedAt: number
  completedAt: number | null
  retryOf: string | null
  taskLabel: string | null
  error: string | null
}
