// src/workers/mcpagent/do/agent-finish.ts
// Detached-run terminal delivery, split from agent-dispatch.ts for the file
// line limit. Idempotent per (run, slot): the framework delivers finish and
// budget-give-up at-least-once each; delivery here is claimed through the
// task row before any side effect. Automation-origin runs additionally write
// a delivery event (mission Sendblue reply-window rule — a rejected send is
// logged as a skip, never retried).

import type { Env } from '../../../types/env'
import { decryptWithKek } from '../../../cron/kek'
import { writeAuditLog } from '../../../middleware/audit'
import { enqueueRetainArtifact } from '../../../services/ingestion/enqueue'
import { sendTelegramReply } from '../../../services/delivery/telegram'
import { sendSendblueMessage } from '../../../services/delivery/sendblue'
import { sendSmsReply } from '../../../services/delivery/sms'
import type { DispatchHost } from './agent-dispatch'
import { ensureTaskTable, readTaskRow, claimDelivery, type TaskSql } from './agent-task-store'
import { insertAutomationEvent, type AutoSql } from './automation-store'

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
  const delivery = await deliverToChannel(host.env, task.replyChannel, task.replyTo, note)
  if (task.origin?.startsWith('automation:')) {
    const automationId = task.origin.slice('automation:'.length)
    const status = delivery === 'delivered' ? 'delivered'
      : task.replyChannel === 'sendblue' ? 'skipped_outside_reply_window' : 'delivery_failed'
    insertAutomationEvent(host.sql as AutoSql, automationId, status, runInfo.runId)
  }
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

async function deliverToChannel(env: Env, channel: string, replyTo: string, text: string): Promise<'delivered' | 'failed'> {
  try {
    if (channel === 'telegram') {
      return (await sendTelegramReply(Number(replyTo), text, env)) ? 'delivered' : 'failed'
    }
    if (channel === 'sendblue') {
      return (await sendSendblueMessage(replyTo, text, env)).success ? 'delivered' : 'failed'
    }
    await sendSmsReply(replyTo, text, env)
    return 'delivered'
  } catch {
    console.warn('AGENT_RESULT_DELIVERY_FAILED', { channel })
    return 'failed'
  }
}
