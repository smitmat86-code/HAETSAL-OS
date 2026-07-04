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
import { decryptWithKek, encryptWithKek } from '../../../cron/kek'
import { writeAuditLog } from '../../../middleware/audit'
import { enqueueRetainArtifact } from '../../../services/ingestion/enqueue'
import { sendTelegramReply } from '../../../services/delivery/telegram'
import { sendSendblueMessage } from '../../../services/delivery/sendblue'
import { sendSmsReply } from '../../../services/delivery/sms'
import { ensureTaskTable, insertTaskRow, readTaskRow, claimDelivery, type TaskSql } from './agent-task-store'

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
  })
  void writeAuditLog(host.env, 'agent_run.spawned', tenantId, { agentIdentity: `execution_agent/${spec.profile}` })
  return { runId: dispatched.runId }
}

/** Detached onFinish handler body. Idempotent per (run, slot): the framework
 *  delivers finish and budget-give-up at-least-once each; delivery here is
 *  claimed through the task row before any side effect. */
export async function handleExecutionTaskFinish(
  host: DispatchHost,
  runInfo: { runId: string; status: string },
  lifecycle: { status: string; error?: string; reason?: string },
): Promise<void> {
  const { tenantId, tmk } = host
  if (!tenantId) return
  ensureTaskTable(host.sql)
  const task = readTaskRow(host.sql, runInfo.runId)
  if (!task) return
  const slot = lifecycle.status === 'interrupted' ? 'giveup' : 'final'
  if (!claimDelivery(host.sql, runInfo.runId, slot)) return

  let note: string
  if (lifecycle.status === 'completed' && tmk) {
    const output = readRunOutput(host.sql, runInfo.runId)
    const resultText = output ? await decryptWithKek(output.ciphertext, tmk).catch(() => null) : null
    note = resultText ?? 'The background task finished, but I could not unseal its result.'
    if (resultText) {
      void enqueueRetainArtifact({
        tenantId,
        content: `Execution agent (${task.profile}) finished a delegated task. Result: ${resultText.slice(0, 600)}`,
        source: 'agent:execution_agent',
        memoryType: 'episodic',
        domain: 'general',
        provenance: 'execution_agent_run',
        occurredAt: Date.now(),
      }, host.env, undefined, tmk).catch(() => {})
    }
  } else if (lifecycle.status === 'aborted') {
    note = 'That background task was cancelled.'
  } else if (lifecycle.status === 'interrupted') {
    note = 'A background task stalled and was stopped after its time budget. You can retry it from the dashboard.'
  } else {
    note = `A background task failed${lifecycle.error ? ` (${lifecycle.error.slice(0, 120)})` : ''}. You can retry it from the dashboard.`
  }
  await deliverToChannel(host.env, task.replyChannel, task.replyTo, note)
  void writeAuditLog(host.env, `agent_run.${lifecycle.status}`, tenantId, { agentIdentity: `execution_agent/${task.profile}` })
}

function readRunOutput(sql: TaskSql, runId: string): { ciphertext: string } | null {
  const row = sql<{ output_json: string | null }>`
    SELECT output_json FROM cf_agent_tool_runs WHERE run_id = ${runId}
  `[0]
  if (!row?.output_json) return null
  try {
    const parsed = JSON.parse(row.output_json) as { ciphertext?: string }
    return typeof parsed.ciphertext === 'string' ? { ciphertext: parsed.ciphertext } : null
  } catch { return null }
}

async function deliverToChannel(env: Env, channel: string, replyTo: string, text: string): Promise<void> {
  try {
    if (channel === 'telegram') await sendTelegramReply(Number(replyTo), text, env)
    else if (channel === 'sendblue') await sendSendblueMessage(replyTo, text, env)
    else await sendSmsReply(replyTo, text, env)
  } catch {
    console.warn('AGENT_RESULT_DELIVERY_FAILED', { channel })
  }
}
