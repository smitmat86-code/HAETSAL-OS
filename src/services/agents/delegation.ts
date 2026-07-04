// src/services/agents/delegation.ts
// Phase 6 delegation decider — replaces the never-wired parseDelegation()
// text signal with a real dispatch decision in front of the channel reply
// path. Pattern-first (~0ms) with a MODEL_CHAT classifier fallback;
// conservative default is inline (the existing grounded reply). On delegate,
// the tenant DO spawns an ExecutionAgent facet (native runAgentTool) and the
// channel gets an immediate ack; the result arrives as a follow-up message.

import { getAgentByName } from 'agents'
import type { Env } from '../../types/env'
import type { ExecutionProfile } from '../../agents/execution/types'
import type { McpAgentDO } from '../../workers/mcpagent/do/McpAgent'
import type { ReplyChannel } from '../../workers/mcpagent/do/agent-dispatch'
import { getMcpAgentObjectName } from '../../workers/mcpagent/do/identity'
import { runGatewayChat } from '../workers-ai-chat'

export type DelegationDecision =
  | { kind: 'inline' }
  | { kind: 'delegate'; profile: ExecutionProfile }

const RESEARCH_PATTERNS = /\b(research|investigate|look (that |this |it )?up|find out|dig into|search the web|compare .{3,} (options|prices|tools)|compile|figure out what)\b/i
const MEMORY_PATTERNS = /\b(summari[sz]e (what|my|everything)|what did i (say|do|decide)|catch me up|what have (i|we) (said|done|decided)|go through my (memories|notes))\b/i
const SHORT_INLINE_MAX = 18 // words — short conversational turns never delegate

export async function decideDelegation(text: string, env: Env): Promise<DelegationDecision> {
  if (RESEARCH_PATTERNS.test(text)) return { kind: 'delegate', profile: 'research' }
  if (MEMORY_PATTERNS.test(text)) return { kind: 'delegate', profile: 'memory' }
  if (text.trim().split(/\s+/).length <= SHORT_INLINE_MAX) return { kind: 'inline' }
  try {
    const answer = await runGatewayChat(env, [{
      role: 'user',
      content: `Classify this assistant request. Reply with exactly one word.
inline — answerable directly in one chat turn
research — needs multi-step web research
memory — needs a deep sweep of the user's stored memories

Request: "${text.slice(0, 300)}"`,
    }], 16)
    const label = (answer ?? '').trim().toLowerCase().replace(/[^a-z]/g, '')
    if (label === 'research' || label === 'memory') return { kind: 'delegate', profile: label }
  } catch { /* classifier failure → inline */ }
  return { kind: 'inline' }
}

export interface DelegationRoute {
  channel: ReplyChannel
  replyTo: string
}

/** Returns the ack text when the message was delegated to an execution agent,
 *  or null when the caller should fall back to the inline grounded reply
 *  (inline decision, DO without a session key, or dispatch failure). */
export async function maybeDelegateExecutionTask(
  env: Env,
  tenantId: string,
  text: string,
  route: DelegationRoute,
): Promise<string | null> {
  const decision = await decideDelegation(text, env)
  if (decision.kind !== 'delegate') return null
  try {
    const namespace = env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
    const stub = await getAgentByName(namespace, getMcpAgentObjectName(tenantId))
    const { runId } = await stub.dispatchExecutionTask({
      task: text,
      profile: decision.profile,
      replyChannel: route.channel,
      replyTo: route.replyTo,
    })
    console.log('EXECUTION_TASK_DELEGATED', { profile: decision.profile, runId })
    return `On it — I've started a ${decision.profile} agent on that. I'll message you here when it's done (usually under a minute). You can watch or cancel it from the dashboard.`
  } catch (error) {
    console.warn('EXECUTION_DELEGATION_FALLBACK_INLINE', {
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 120),
    })
    return null
  }
}
