// src/services/action/integrations/reminder.ts
// act_remind executor. Schedules a future reminder on the tenant's DO via the
// Agents SDK scheduler (this.schedule). The DO encrypts the message with the
// tenant TMK before it is persisted and delivers it over the tenant channel
// when it fires. The executor itself only computes the fire time and hands off.

import type { Env } from '../../../types/env'
import { getMcpAgentObjectId } from '../../../workers/mcpagent/do/identity'

export interface ReminderResult {
  scheduledFor: number
}

export async function executeReminder(
  input: { message: string; remind_at: string; channel?: string },
  tenantId: string,
  env: Env,
): Promise<ReminderResult> {
  const remindAtMs = Date.parse(input.remind_at)
  if (Number.isNaN(remindAtMs)) throw new Error(`Invalid remind_at: ${input.remind_at}`)
  if (remindAtMs <= Date.now()) throw new Error('remind_at must be in the future')

  const doId = getMcpAgentObjectId(env.MCPAGENT, tenantId)
  const stub = env.MCPAGENT.get(doId) as unknown as {
    scheduleReminder(remindAtMs: number, message: string, channel?: string): Promise<{ scheduledFor: number }>
  }
  const result = await stub.scheduleReminder(remindAtMs, input.message, input.channel)
  return { scheduledFor: result.scheduledFor }
}
