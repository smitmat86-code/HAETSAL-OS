// src/services/session/client.ts
// Worker-side helpers for the channel handlers: fetch the working-session
// window before composing a reply, and record the exchange afterwards
// (fire-and-forget — a session bookkeeping failure must never break the
// reply path). Session keys are `<channel>:<peer>`.

import { getAgentByName } from 'agents'
import type { Env } from '../../types/env'
import type { McpAgentDO } from '../../workers/mcpagent/do/McpAgent'
import { getMcpAgentObjectName } from '../../workers/mcpagent/do/identity'

async function stubFor(env: Env, tenantId: string): Promise<McpAgentDO> {
  const namespace = env.MCPAGENT as unknown as DurableObjectNamespace<McpAgentDO>
  // `await` so a failure is observed in this frame — workerd's unhandled-
  // rejection tracker fires on un-awaited returns (same trap as the SDK docs).
  return await (getAgentByName(namespace, getMcpAgentObjectName(tenantId)) as unknown as Promise<McpAgentDO>)
}

function hasNamespace(env: Env): boolean {
  // Absent in the vitest pool (test entry excludes the DO). Guarding here
  // avoids creating an already-rejected promise the tracker would flag.
  return Boolean((env as { MCPAGENT?: { idFromName?: unknown } }).MCPAGENT?.idFromName)
}

/** Recent-window prompt block, or '' when unavailable (cold DO, no key). */
export async function fetchSessionBlock(env: Env, tenantId: string, sessionKey: string): Promise<string> {
  if (!hasNamespace(env)) return ''
  try {
    const stub = await stubFor(env, tenantId)
    return await stub.getSessionWindowBlock(sessionKey)
  } catch { return '' }
}

export function recordSessionExchange(
  env: Env,
  tenantId: string,
  sessionKey: string,
  userText: string,
  assistantText: string,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): void {
  if (!hasNamespace(env)) return
  ctx.waitUntil((async () => {
    try {
      const stub = await stubFor(env, tenantId)
      await stub.recordSessionExchange(sessionKey, userText, assistantText)
    } catch (error) {
      console.warn('SESSION_RECORD_FAILED', {
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 80),
      })
    }
  })())
}
