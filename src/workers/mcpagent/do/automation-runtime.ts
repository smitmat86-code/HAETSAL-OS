// src/workers/mcpagent/do/automation-runtime.ts
// Automation lifecycle on the tenant DO: create (encrypt spec + arm one-shot
// alarm), fire (dispatch a scoped execution-agent run, then RE-ARM the next
// tz-correct occurrence), toggle, delete, list. Fires that cannot dispatch
// (no session key) record an honest skip event and still re-arm — the mission
// forbids retry workarounds; the next occurrence is the retry.

import { decryptWithKek, encryptWithKek } from '../../../cron/kek'
import { writeAuditLog } from '../../../middleware/audit'
import {
  describeRecurrence, nextOccurrence, type RecurrenceSpec,
} from '../../../services/automations/recurrence'
import { dispatchExecutionTask, DispatchUnavailableError, type DispatchHost, type ReplyChannel } from './agent-dispatch'
import {
  ensureAutomationTables, insertAutomation, insertAutomationEvent, readAutomation,
  recordFire, resolveAutomationId, setAutomationEnabled, setAutomationSchedule,
  deleteAutomationRow, type AutomationRow, type AutoSql,
} from './automation-store'
import type { ExecutionProfile } from '../../../agents/execution/types'

export interface AutomationHost extends DispatchHost {
  schedule: (when: Date, callback: string, payload: unknown) => Promise<{ id: string }>
  cancelSchedule: (id: string) => Promise<boolean>
}

export interface CreateAutomationInput {
  task: string
  spec: RecurrenceSpec
  profile?: ExecutionProfile
  replyChannel: ReplyChannel
  replyTo: string
}

export interface AutomationView {
  id: string
  idShort: string
  task: string
  schedule: string
  enabled: boolean
  nextFireAt: number | null
  lastFiredAt: number | null
  lastStatus: string | null
  events: Array<{ at: number; status: string; run_id: string | null }>
}

const FIRE_CALLBACK = 'fireAutomation'

function inferProfile(task: string): ExecutionProfile {
  return /\b(brief|summari[sz]e|catch me up|recap|review my)\b/i.test(task) ? 'memory' : 'research'
}

export async function createAutomation(host: AutomationHost, input: CreateAutomationInput): Promise<{ id: string; description: string }> {
  if (!host.tmk || !host.tenantId) throw new DispatchUnavailableError('tenant session key unavailable')
  ensureAutomationTables(host.sql as AutoSql)
  const id = crypto.randomUUID()
  const row: AutomationRow = {
    id,
    kind: input.spec.kind, hour: input.spec.hour, minute: input.spec.minute,
    day_of_week: input.spec.dayOfWeek ?? null, tz: input.spec.tz,
    profile: input.profile ?? inferProfile(input.task),
    reply_channel: input.replyChannel, reply_to: input.replyTo,
    spec_ciphertext: await encryptWithKek(JSON.stringify({ task: input.task }), host.tmk),
    enabled: 1, schedule_id: null, created_at: Date.now(),
    last_fired_at: null, last_status: null,
  }
  insertAutomation(host.sql as AutoSql, row)
  await armNext(host, row)
  void writeAuditLog(host.env, 'automation.created', host.tenantId, { agentIdentity: 'automation_manager' })
  return { id, description: describeRecurrence(input.spec) }
}

async function armNext(host: AutomationHost, row: AutomationRow): Promise<void> {
  const fireAt = nextOccurrence(specOf(row), Date.now())
  const schedule = await host.schedule(new Date(fireAt), FIRE_CALLBACK, { automationId: row.id })
  setAutomationSchedule(host.sql as AutoSql, row.id, schedule.id)
}

export function specOf(row: AutomationRow): RecurrenceSpec {
  return {
    kind: row.kind, hour: row.hour, minute: row.minute,
    ...(row.day_of_week !== null ? { dayOfWeek: row.day_of_week } : {}), tz: row.tz,
  }
}

/** DO alarm callback body. Dispatch, record, and ALWAYS re-arm. */
export async function fireAutomationTick(host: AutomationHost, payload: { automationId: string }): Promise<void> {
  ensureAutomationTables(host.sql as AutoSql)
  const row = readAutomation(host.sql as AutoSql, payload.automationId)
  if (!row || row.enabled !== 1) return
  try {
    if (!host.tmk) throw new DispatchUnavailableError('tenant session key unavailable at fire time')
    const spec = JSON.parse(await decryptWithKek(row.spec_ciphertext, host.tmk)) as { task: string }
    const { runId } = await dispatchExecutionTask(host, {
      task: spec.task,
      profile: row.profile as ExecutionProfile,
      replyChannel: row.reply_channel as ReplyChannel,
      replyTo: row.reply_to,
      origin: `automation:${row.id}`,
    })
    recordFire(host.sql as AutoSql, row.id, 'dispatched')
    insertAutomationEvent(host.sql as AutoSql, row.id, 'dispatched', runId)
  } catch (error) {
    const status = error instanceof DispatchUnavailableError ? 'skipped_no_session' : 'dispatch_failed'
    recordFire(host.sql as AutoSql, row.id, status)
    insertAutomationEvent(host.sql as AutoSql, row.id, status, null)
  } finally {
    await armNext(host, row).catch(() => {})
  }
}

export async function toggleAutomation(host: AutomationHost, idPrefix: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  ensureAutomationTables(host.sql as AutoSql)
  const id = resolveAutomationId(host.sql as AutoSql, idPrefix)
  if (!id) throw new Error('automation not found (or prefix is ambiguous)')
  const row = readAutomation(host.sql as AutoSql, id)!
  if (row.schedule_id) await host.cancelSchedule(row.schedule_id).catch(() => {})
  if (enabled) {
    setAutomationEnabled(host.sql as AutoSql, id, true, null)
    await armNext(host, { ...row, enabled: 1 })
  } else {
    setAutomationEnabled(host.sql as AutoSql, id, false, null)
  }
  if (host.tenantId) void writeAuditLog(host.env, `automation.${enabled ? 'resumed' : 'paused'}`, host.tenantId, { agentIdentity: 'automation_manager' })
  return { id, enabled }
}

export async function removeAutomation(host: AutomationHost, idPrefix: string): Promise<{ id: string }> {
  ensureAutomationTables(host.sql as AutoSql)
  const id = resolveAutomationId(host.sql as AutoSql, idPrefix)
  if (!id) throw new Error('automation not found (or prefix is ambiguous)')
  const row = readAutomation(host.sql as AutoSql, id)!
  if (row.schedule_id) await host.cancelSchedule(row.schedule_id).catch(() => {})
  deleteAutomationRow(host.sql as AutoSql, id)
  if (host.tenantId) void writeAuditLog(host.env, 'automation.deleted', host.tenantId, { agentIdentity: 'automation_manager' })
  return { id }
}
