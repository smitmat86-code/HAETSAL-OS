// src/services/agents/automation-chat.ts
// Chat-to-automation seam (Phase 7): recognizes automation creation intent
// ("every weekday at 8am, brief me on my day") and management commands
// ("list automations", "pause automation ab12") ahead of the delegation
// decider. Returns the reply text, or null to fall through.

import { getAgentByName } from 'agents'
import type { Env } from '../../types/env'
import type { McpAgentDO } from '../../workers/mcpagent/do/McpAgent'
import type { ReplyChannel } from '../../workers/mcpagent/do/agent-dispatch'
import { getMcpAgentObjectName } from '../../workers/mcpagent/do/identity'
import { parseAutomationCommand, parseAutomationIntent } from '../automations/nl-parse'

export interface AutomationChatRoute {
  channel: ReplyChannel
  replyTo: string
}

async function tenantStub(env: Env, tenantId: string): Promise<McpAgentDO> {
  const namespace = env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  return getAgentByName(namespace, getMcpAgentObjectName(tenantId)) as unknown as Promise<McpAgentDO>
}

export async function maybeHandleAutomationChat(
  env: Env,
  tenantId: string,
  text: string,
  route: AutomationChatRoute,
): Promise<string | null> {
  const command = parseAutomationCommand(text)
  if (command) return handleCommand(env, tenantId, command).catch(honestFailure)

  const parsed = parseAutomationIntent(text)
  if (!parsed) return null
  try {
    const stub = await tenantStub(env, tenantId)
    const { id, description } = await stub.createAutomationRpc({
      task: parsed.task,
      spec: parsed.spec,
      replyChannel: route.channel,
      replyTo: route.replyTo,
    })
    console.log('AUTOMATION_CREATED_FROM_CHAT', { id: id.slice(0, 8) })
    return `Automation created — I'll run "${parsed.task}" ${description}. It fires as a background agent and the result lands here. Manage it with "list automations", "pause automation ${id.slice(0, 8)}", or "delete automation ${id.slice(0, 8)}".`
  } catch (error) {
    return honestFailure(error)
  }
}

async function handleCommand(
  env: Env,
  tenantId: string,
  command: NonNullable<ReturnType<typeof parseAutomationCommand>>,
): Promise<string> {
  const stub = await tenantStub(env, tenantId)
  if (command.kind === 'list') {
    const views = await stub.listAutomationsRpc()
    if (views.length === 0) return 'No automations yet. Try: "every weekday at 8am, brief me on my day".'
    return views.map(v =>
      `${v.enabled ? '[on]' : '[paused]'} ${v.idShort} — "${v.task}" ${v.schedule}` +
      (v.lastStatus ? ` · last: ${v.lastStatus}` : '')).join('\n')
  }
  if (command.kind === 'toggle') {
    const result = await stub.toggleAutomationRpc(command.idPrefix, command.enabled)
    return `Automation ${result.id.slice(0, 8)} is now ${result.enabled ? 'on' : 'paused'}.`
  }
  const result = await stub.deleteAutomationRpc(command.idPrefix)
  return `Automation ${result.id.slice(0, 8)} deleted.`
}

function honestFailure(error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 120)
  console.warn('AUTOMATION_CHAT_FAILED', { reason })
  return `I couldn't do that automation change (${reason}).`
}
