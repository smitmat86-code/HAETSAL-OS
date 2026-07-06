// src/agents/execution-agent.ts
// Phase 6 execution agent — a sub-agent facet spawned by McpAgentDO via
// runAgentTool, implementing the SDK agent-tool child adapter directly on a
// lean Agent subclass (Think deferred; see phase-6-subagent-plan.md).
// Dispatch contract: the parent AWAITS startAgentToolRun, so it returns
// `running` immediately and the loop finishes under waitUntil+keepAliveWhile;
// tailAgentToolRun closes at terminal for fast detached delivery (durable
// backbone fallback). Law 2: plaintext task lives in memory only; the result
// is TMK-encrypted before rest (TMK re-derived from jwtSub, same derivation
// as initTenant so parent/child ciphertexts interoperate).

import { Agent } from 'agents'
import type { Env } from '../types/env'
import { deriveTmk } from '../middleware/auth'
import { encryptWithKek } from '../cron/kek'
import { runExecutionToolLoop } from './execution/tool-loop'
import { resolveSystemPrompt } from '../services/prompts/overrides'
import { persistExecutionTrace } from './execution/trace'
import type { ExecutionProgress, ExecutionRunOutput, ExecutionTaskInput } from './execution/types'
import {
  buildTerminalTailStream, ensureRunTable, finishRun, insertRun, isCancelled,
  markCancelled, readRun, sanitizeExecutionError, writeProgress, type RunSql,
} from './execution/run-store'

const DEFAULT_MAX_TURNS = 6
const DEFAULT_DEADLINE_MS = 10 * 60_000 // soft; parent maxBudgetMs is the hard 15m
const TAIL_POLL_MS = 500
const TAIL_CAP_MS = 16 * 60_000 // just past the parent's hard budget

interface RunInspection {
  runId: string
  status: 'running' | 'completed' | 'error' | 'aborted'
  output?: ExecutionRunOutput
  summary?: string
  error?: string
  startedAt: number
  completedAt?: number
  progress?: ExecutionProgress
}

export class ExecutionAgent extends Agent<Env> {
  private runSql(): RunSql {
    const bound = this.sql.bind(this) as RunSql
    ensureRunTable(bound)
    return bound
  }

  /** Agent-tool child adapter: register the run and return `running` at once;
   *  the tool loop completes in background under a keep-alive lease. */
  async startAgentToolRun(input: ExecutionTaskInput, options: { runId: string }): Promise<RunInspection> {
    const sql = this.runSql()
    insertRun(sql, options.runId)
    this.ctx.waitUntil(
      this.keepAliveWhile(() => this.executeRun(input, options.runId)).catch(() => {}),
    )
    return this.inspectionFor(options.runId)
  }

  private async executeRun(input: ExecutionTaskInput, runId: string): Promise<void> {
    const sql = this.runSql()
    const startedAt = Date.now()
    try {
      const tmk = await deriveTmk(input.jwtSub, this.env.CF_ACCESS_AUD)
      // Phase 14: user-editable preamble (resolve never throws; defaults on fallback)
      const preamble = await resolveSystemPrompt(this.env, input.tenantId, 'agent.execution_preamble')
      const result = await runExecutionToolLoop({
        env: this.env,
        tenantId: input.tenantId,
        tmk,
        preamble: preamble.text,
        agentIdentity: `execution_agent/${input.profile}`,
        task: input.task,
        contextNote: input.contextNote,
        allowedTools: input.allowedTools,
        maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
        deadlineAt: Date.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS),
        isCancelled: () => isCancelled(sql, runId),
        onProgress: (fraction, phase) => writeProgress(sql, runId, { fraction, phase, at: Date.now() }),
      })
      if (result.status === 'aborted') {
        finishRun(sql, runId, { status: 'aborted', summary: 'aborted:cancelled' })
        return
      }
      const output: ExecutionRunOutput = {
        ciphertext: await encryptWithKek(result.resultText, tmk),
        turns: result.turns,
        toolCalls: result.toolCalls,
        toolsUsed: result.toolsUsed,
      }
      finishRun(sql, runId, {
        status: 'completed',
        outputJson: JSON.stringify(output),
        summary: `completed:${input.profile}:${result.toolCalls} tool calls`,
      })
      // Phase 9: encrypted structured reasoning trace (fire-and-forget).
      this.ctx.waitUntil(persistExecutionTrace(this.env, tmk, {
        runId, tenantId: input.tenantId, profile: input.profile, task: input.task,
        status: result.status, turns: result.turns, toolCalls: result.toolCalls,
        toolsUsed: result.toolsUsed, resultText: result.resultText, startedAt, endedAt: Date.now(),
      }))
    } catch (error) {
      // Fixed-vocabulary only (Law 2): raw messages could embed content.
      finishRun(sql, runId, { status: 'error', error: sanitizeExecutionError(error) })
    }
  }

  /** Cooperative cancel: ledger flips to aborted immediately; the loop
   *  observes the flag at its next checkpoint and stops without effects. */
  async cancelAgentToolRun(runId: string, _reason?: unknown): Promise<void> {
    markCancelled(this.runSql(), runId)
  }

  async inspectAgentToolRun(runId: string): Promise<RunInspection | null> {
    const row = readRun(this.runSql(), runId)
    return row ? this.rowToInspection(row) : null
  }

  /** No streamed content — this agent reports via progress snapshots only. */
  async getAgentToolChunks(_runId: string, _options?: { afterSequence?: number }): Promise<Array<{ sequence: number; body: string }>> {
    return []
  }

  /** Tail closes at terminal → the parent's warm fast path delivers the
   *  detached completion within ~1s of the loop finishing (backbone fallback). */
  async tailAgentToolRun(runId: string, _options?: { afterSequence?: number }): Promise<ReadableStream<{ sequence: number; body: string }>> {
    return buildTerminalTailStream(this.runSql(), runId, TAIL_CAP_MS, TAIL_POLL_MS)
  }

  private inspectionFor(runId: string): RunInspection {
    const row = readRun(this.runSql(), runId)
    if (!row) throw new Error(`execution run ${runId} missing after write`)
    return this.rowToInspection(row)
  }

  private rowToInspection(row: NonNullable<ReturnType<typeof readRun>>): RunInspection {
    return {
      runId: row.run_id,
      status: row.status,
      ...(row.output_json ? { output: JSON.parse(row.output_json) as ExecutionRunOutput } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.error ? { error: row.error } : {}),
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.progress_json ? { progress: JSON.parse(row.progress_json) as ExecutionProgress } : {}),
    }
  }
}
