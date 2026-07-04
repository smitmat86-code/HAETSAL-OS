// src/workers/mcpagent/do/agent-runs-view.ts
// Dashboard-facing run listing + cancel + retry on the parent DO. Every field
// returned here is content-free (Law 2): profile, tool names, status, progress
// phase labels, counters, timestamps. Cancel routes through the SDK's
// cancelAgentTool (child flag + ledger + detached finish delivery); retry
// decrypts the stored task spec and dispatches a fresh run with lineage.

import type { Env } from '../../../types/env'
import { ExecutionAgent } from '../../../agents/execution-agent'
import type { AgentRunView, ExecutionProfile, ExecutionProgress } from '../../../agents/execution/types'
import { decryptWithKek } from '../../../cron/kek'
import { writeAuditLog } from '../../../middleware/audit'
import { dispatchExecutionTask, type DispatchHost, type ReplyChannel } from './agent-dispatch'
import { ensureTaskTable, readTaskRow, type TaskSql } from './agent-task-store'

export interface RunsHost extends DispatchHost {
  cancelAgentTool: (runId: string, reason?: unknown) => Promise<void>
  subAgent: (cls: typeof ExecutionAgent, name: string) => Promise<{
    inspectAgentToolRun: (runId: string) => Promise<{ progress?: ExecutionProgress; status?: string } | null>
  }>
}

interface LedgerRow {
  run_id: string
  agent_type: string
  input_preview: string | null
  status: string
  error_message: string | null
  started_at: number
  completed_at: number | null
}

const LIVE_STATUSES = new Set(['starting', 'running'])

export async function listAgentRuns(host: RunsHost, limit = 20): Promise<AgentRunView[]> {
  ensureTaskTable(host.sql)
  const rows = host.sql<LedgerRow>`
    SELECT run_id, agent_type, input_preview, status, error_message, started_at, completed_at
    FROM cf_agent_tool_runs
    ORDER BY started_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `
  const views: AgentRunView[] = []
  for (const row of rows) {
    const task = readTaskRow(host.sql, row.run_id)
    const preview = parsePreview(row.input_preview)
    let progress: ExecutionProgress | null = null
    if (LIVE_STATUSES.has(row.status)) {
      progress = await liveProgress(host, row.run_id)
    }
    views.push({
      runId: row.run_id,
      agentType: row.agent_type,
      profile: task?.profile ?? preview.profile,
      tools: task?.tools ?? preview.tools,
      status: row.status,
      progress,
      heartbeatAgeMs: progress ? Math.max(Date.now() - progress.at, 0) : null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      retryOf: task?.retryOf ?? null,
      taskLabel: task ? `${task.profile} task` : null,
      error: row.error_message,
    })
  }
  return views
}

export async function cancelAgentRun(host: RunsHost, runId: string): Promise<{ cancelled: boolean }> {
  await host.cancelAgentTool(runId, 'cancelled from dashboard')
  if (host.tenantId) {
    void writeAuditLog(host.env, 'agent_run.cancel_requested', host.tenantId, { agentIdentity: 'dashboard' })
  }
  return { cancelled: true }
}

export async function retryAgentRun(host: RunsHost, runId: string): Promise<{ runId: string }> {
  ensureTaskTable(host.sql)
  const task = readTaskRow(host.sql, runId)
  if (!task) throw new Error('unknown run — nothing to retry')
  if (!host.tmk) throw new Error('tenant session key unavailable — open the dashboard once to refresh it')
  const status = host.sql<{ status: string }>`
    SELECT status FROM cf_agent_tool_runs WHERE run_id = ${runId}
  `[0]?.status
  if (status && LIVE_STATUSES.has(status)) throw new Error('run is still active — cancel it first')

  const spec = JSON.parse(await decryptWithKek(task.taskCiphertext, host.tmk)) as { task: string; contextNote: string | null }
  const dispatched = await dispatchExecutionTask(host, {
    task: spec.task,
    ...(spec.contextNote ? { contextNote: spec.contextNote } : {}),
    profile: task.profile as ExecutionProfile,
    replyChannel: task.replyChannel as ReplyChannel,
    replyTo: task.replyTo,
    retryOf: runId,
  })
  if (host.tenantId) {
    void writeAuditLog(host.env, 'agent_run.retried', host.tenantId, { agentIdentity: `execution_agent/${task.profile}` })
  }
  return dispatched
}

async function liveProgress(host: RunsHost, runId: string): Promise<ExecutionProgress | null> {
  try {
    const child = await host.subAgent(ExecutionAgent, runId)
    const inspection = await child.inspectAgentToolRun(runId)
    return inspection?.progress ?? null
  } catch { return null }
}

function parsePreview(json: string | null): { profile: string | null; tools: string[] } {
  if (!json) return { profile: null, tools: [] }
  try {
    const parsed = JSON.parse(json) as { profile?: unknown; tools?: unknown }
    return {
      profile: typeof parsed.profile === 'string' ? parsed.profile : null,
      tools: Array.isArray(parsed.tools) ? parsed.tools.filter((t): t is string => typeof t === 'string') : [],
    }
  } catch { return { profile: null, tools: [] } }
}
