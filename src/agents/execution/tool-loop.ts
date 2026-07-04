// src/agents/execution/tool-loop.ts
// Function-calling loop for execution agents. MODEL_DEEP via AI Gateway with
// collectLog: false (G4). Tool scoping is enforced HERE, structurally: the
// model only ever sees definitions for the allowed subset, and a hallucinated
// out-of-scope call gets an error result instead of executing. Progress
// callbacks carry only the fixed content-free vocabulary (phase + counters).

import { MODEL_DEEP } from '../../config/models'
import { checkDoomLoop } from '../helpers'
import type { DoomLoopState } from '../types'
import type { Env } from '../../types/env'
import type { ExecutionLoopResult, ExecutionToolName } from './types'
import { EXECUTION_TOOLS, toolDefinitionsFor, type ToolRuntime } from './tool-registry'

export interface ToolLoopConfig {
  env: Env
  tenantId: string
  tmk: CryptoKey
  agentIdentity: string
  task: string
  contextNote?: string
  allowedTools: ExecutionToolName[]
  maxTurns: number
  deadlineAt: number
  isCancelled: () => boolean
  onProgress: (fraction: number, phase: string) => void
}

interface RawToolCall { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }

/** Tolerant reader for the two tool_call encodings Workers AI models emit. */
export function parseToolCalls(result: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const calls = (result as { tool_calls?: RawToolCall[] })?.tool_calls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    const name = call.name ?? call.function?.name
    if (!name) return []
    let raw = call.arguments ?? call.function?.arguments ?? {}
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { raw = {} }
    }
    return [{ name, args: (raw ?? {}) as Record<string, unknown> }]
  })
}

function readResponseText(result: unknown): string {
  if (typeof result === 'string') return result.trim()
  const r = result as { response?: unknown }
  return typeof r?.response === 'string' ? r.response.trim() : ''
}

const MAX_CALLS_PER_TURN = 4

export async function runExecutionToolLoop(cfg: ToolLoopConfig): Promise<ExecutionLoopResult> {
  const rt: ToolRuntime = { env: cfg.env, tenantId: cfg.tenantId, tmk: cfg.tmk, agentIdentity: cfg.agentIdentity }
  const tools = toolDefinitionsFor(cfg.allowedTools)
  const doom: DoomLoopState = { calls: [], warnCount: 0 }
  const toolsUsed = new Set<ExecutionToolName>()
  let toolCalls = 0
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt(cfg) },
    { role: 'user', content: cfg.task },
  ]

  for (let turn = 0; turn < cfg.maxTurns; turn++) {
    if (cfg.isCancelled()) return aborted(turn, toolCalls, toolsUsed)
    if (Date.now() > cfg.deadlineAt) {
      return { status: 'completed', resultText: 'I ran out of time before finishing this task completely.', turns: turn, toolCalls, toolsUsed: [...toolsUsed] }
    }
    cfg.onProgress(turn / cfg.maxTurns, turn === 0 ? 'planning' : 'reasoning')

    const result = await (cfg.env.AI as { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> }).run(
      MODEL_DEEP,
      { messages, tools, max_tokens: 1024 },
      { gateway: { id: cfg.env.AI_GATEWAY_ID, collectLog: false } },
    )
    if (cfg.isCancelled()) return aborted(turn + 1, toolCalls, toolsUsed)

    const calls = parseToolCalls(result).slice(0, MAX_CALLS_PER_TURN)
    const text = readResponseText(result)
    if (calls.length === 0) {
      if (text) return { status: 'completed', resultText: text, turns: turn + 1, toolCalls, toolsUsed: [...toolsUsed] }
      messages.push({ role: 'user', content: 'Please give your final answer as plain text.' })
      continue
    }

    messages.push({ role: 'assistant', content: text || `[calling: ${calls.map(c => c.name).join(', ')}]` })
    for (const call of calls) {
      if (cfg.isCancelled()) return aborted(turn + 1, toolCalls, toolsUsed)
      const outcome = await executeScopedTool(call, cfg, rt, doom)
      if (outcome === 'doom_break') {
        return { status: 'completed', resultText: 'I got stuck repeating the same step, so I stopped early. Here is what I had: ' + lastToolResult(messages), turns: turn + 1, toolCalls, toolsUsed: [...toolsUsed] }
      }
      toolCalls++
      if (cfg.allowedTools.includes(call.name as ExecutionToolName)) toolsUsed.add(call.name as ExecutionToolName)
      cfg.onProgress((turn + 1) / cfg.maxTurns, `tool:${call.name.slice(0, 40)}`)
      messages.push({ role: 'tool', name: call.name, content: outcome })
    }
  }
  return { status: 'completed', resultText: 'I hit my step limit before fully finishing. Partial findings: ' + lastToolResult(messages), turns: cfg.maxTurns, toolCalls, toolsUsed: [...toolsUsed] }
}

async function executeScopedTool(
  call: { name: string; args: Record<string, unknown> },
  cfg: ToolLoopConfig,
  rt: ToolRuntime,
  doom: DoomLoopState,
): Promise<string> {
  const loopCheck = await checkDoomLoop(doom, call.name, call.args)
  if (loopCheck === 'break') return 'doom_break'
  const allowed = cfg.allowedTools.includes(call.name as ExecutionToolName)
  if (!allowed || !(call.name in EXECUTION_TOOLS)) {
    return JSON.stringify({ error: `tool '${call.name.slice(0, 60)}' is not available in this run` })
  }
  try {
    return await EXECUTION_TOOLS[call.name as ExecutionToolName].execute(call.args, rt)
  } catch (error) {
    return JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
  }
}

function aborted(turns: number, toolCalls: number, toolsUsed: Set<ExecutionToolName>): ExecutionLoopResult {
  return { status: 'aborted', resultText: '', turns, toolCalls, toolsUsed: [...toolsUsed] }
}

function lastToolResult(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') return String(messages[i].content).slice(0, 600)
  }
  return '(none)'
}

function systemPrompt(cfg: ToolLoopConfig): string {
  return `You are a focused execution agent for HAETSAL, the user's personal brain. Complete the task using the available tools, then give a final plain-text answer.

Rules:
- Use tools when they help; answer directly once you have enough.
- Cite specifics (dates, names, sources) from tool results.
- propose_* tools only STAGE actions for human approval — say so if you use one.
- Be concise: the answer is delivered as a chat message.${cfg.contextNote ? `\n\nContext: ${cfg.contextNote}` : ''}`
}
