// src/workers/mcpagent/do/agent-dispatch.ts
// Parent-side sub-agent dispatch (Phase 6). The tenant McpAgentDO is the
// interaction agent: it spawns ExecutionAgent facets via the SDK's
// runAgentTool with per-spawn tool scoping and the boop-style stuck-agent
// budgets (15-min hard ceiling, 5-min silence-after-progress window), and
// delivers detached results over the tenant's channel on finish. Law 2: task
// specs rest TMK-encrypted; audit rows/previews carry only profile + tools.

import type { Env } from '../../../types/env'
import { ExecutionAgent } from '../../../agents/execution-agent'
import { PROFILE_TOOLS, type ExecutionProfile, type ExecutionTaskInput } from '../../../agents/execution/types'
import { encryptWithKek } from '../../../cron/kek'
import { writeAuditLog } from '../../../middleware/audit'
import { ensureTaskTable, insertTaskRow, type TaskSql } from './agent-task-store'

// Terminal delivery lives in agent-finish.ts (line-limit split); re-exported
// so existing imports keep one entry point for the dispatch surface.
export { handleExecutionTaskFinish } from './agent-finish'

export const EXECUTION_MAX_BUDGET_MS = 15 * 60_000
export const EXECUTION_NO_PROGRESS_BUDGET_MS = 5 * 60_000
export type ReplyChannel = 'telegram' | 'sendblue' | 'sms'

export interface ExecutionTaskSpec {
  task: string
  contextNote?: string
  profile: ExecutionProfile
  replyChannel: ReplyChannel
  replyTo: string
  retryOf?: string
  /** Content-free provenance tag, e.g. 'automation:<id>' (Phase 7). */
  origin?: string
}

/** Structural view of the McpAgentDO surface this module needs. */
export interface DispatchHost {
  env: Env
  sql: TaskSql
  tenantId: string | null
  tmk: CryptoKey | null
  jwtSub: string | null
  runAgentTool: (cls: typeof ExecutionAgent, options: {
    input: ExecutionTaskInput
    inputPreview: unknown
    detached: { onFinish: string; maxBudgetMs: number; noProgressBudgetMs: number }
  }) => Promise<{ runId: string; status: string; error?: string }>
}

export class DispatchUnavailableError extends Error {}

export async function dispatchExecutionTask(host: DispatchHost, spec: ExecutionTaskSpec): Promise<{ runId: string }> {
  const { tenantId, tmk, jwtSub } = host
  if (!tenantId || !tmk || !jwtSub) {
    throw new DispatchUnavailableError('tenant session key unavailable — open the dashboard once to refresh it')
  }
  const allowedTools = PROFILE_TOOLS[spec.profile]
  const dispatched = await host.runAgentTool(ExecutionAgent, {
    input: {
      tenantId, jwtSub,
      task: spec.task,
      ...(spec.contextNote ? { contextNote: spec.contextNote } : {}),
      profile: spec.profile,
      allowedTools,
    },
    inputPreview: { profile: spec.profile, tools: allowedTools },
    detached: {
      onFinish: 'onExecutionTaskFinish',
      maxBudgetMs: EXECUTION_MAX_BUDGET_MS,
      noProgressBudgetMs: EXECUTION_NO_PROGRESS_BUDGET_MS,
    },
  })
  if (dispatched.status === 'error') {
    throw new DispatchUnavailableError(dispatched.error ?? 'sub-agent dispatch rejected')
  }
  ensureTaskTable(host.sql)
  insertTaskRow(host.sql, {
    runId: dispatched.runId,
    profile: spec.profile,
    tools: allowedTools,
    taskCiphertext: await encryptWithKek(JSON.stringify({ task: spec.task, contextNote: spec.contextNote ?? null }), tmk),
    replyChannel: spec.replyChannel,
    replyTo: spec.replyTo,
    retryOf: spec.retryOf ?? null,
    origin: spec.origin ?? null,
  })
  void writeAuditLog(host.env, 'agent_run.spawned', tenantId, { agentIdentity: `execution_agent/${spec.profile}` })
  return { runId: dispatched.runId }
}
