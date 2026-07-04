// src/agents/execution/run-store.ts
// SQLite persistence for ExecutionAgent runs (facet-local storage). Law 2:
// output is stored TMK-encrypted; progress/summary use the fixed content-free
// vocabulary. The cancelled flag is the cooperative cancellation signal the
// loop polls between model calls and tool executions.

import type { ExecutionProgress } from './types'

type SqlValue = string | number | boolean | null
export type RunSql = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray, ...values: SqlValue[]
) => T[]

export interface ExecutionRunRow {
  run_id: string
  status: 'running' | 'completed' | 'error' | 'aborted'
  started_at: number
  completed_at: number | null
  output_json: string | null
  summary: string | null
  error: string | null
  progress_json: string | null
  cancelled: number
  heartbeat_at: number
}

export function ensureRunTable(sql: RunSql): void {
  sql`
    CREATE TABLE IF NOT EXISTS haetsal_execution_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      output_json TEXT,
      summary TEXT,
      error TEXT,
      progress_json TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      heartbeat_at INTEGER NOT NULL
    )
  `
}

export function insertRun(sql: RunSql, runId: string): void {
  const now = Date.now()
  sql`
    INSERT INTO haetsal_execution_runs (run_id, status, started_at, cancelled, heartbeat_at)
    VALUES (${runId}, 'running', ${now}, 0, ${now})
    ON CONFLICT(run_id) DO NOTHING
  `
}

export function readRun(sql: RunSql, runId: string): ExecutionRunRow | null {
  return sql<ExecutionRunRow>`
    SELECT run_id, status, started_at, completed_at, output_json, summary,
           error, progress_json, cancelled, heartbeat_at
    FROM haetsal_execution_runs WHERE run_id = ${runId}
  `[0] ?? null
}

export function writeProgress(sql: RunSql, runId: string, progress: ExecutionProgress): void {
  sql`
    UPDATE haetsal_execution_runs
    SET progress_json = ${JSON.stringify(progress)}, heartbeat_at = ${progress.at}
    WHERE run_id = ${runId} AND status = 'running'
  `
}

export function isCancelled(sql: RunSql, runId: string): boolean {
  const row = sql<{ cancelled: number }>`
    SELECT cancelled FROM haetsal_execution_runs WHERE run_id = ${runId}
  `[0]
  return (row?.cancelled ?? 0) === 1
}

/** Cancel: terminal status flips immediately so the ledger/dashboard reflect
 *  the abort without waiting for the loop to notice the flag. */
export function markCancelled(sql: RunSql, runId: string): void {
  sql`
    UPDATE haetsal_execution_runs
    SET cancelled = 1, status = 'aborted', completed_at = ${Date.now()},
        summary = COALESCE(summary, 'aborted:cancelled')
    WHERE run_id = ${runId} AND status = 'running'
  `
  sql`
    UPDATE haetsal_execution_runs SET cancelled = 1 WHERE run_id = ${runId}
  `
}

export function finishRun(
  sql: RunSql, runId: string,
  terminal: { status: 'completed' | 'error' | 'aborted'; outputJson?: string; summary?: string; error?: string },
): void {
  sql`
    UPDATE haetsal_execution_runs
    SET status = ${terminal.status},
        completed_at = ${Date.now()},
        output_json = ${terminal.outputJson ?? null},
        summary = ${terminal.summary ?? null},
        error = ${terminal.error ?? null}
    WHERE run_id = ${runId} AND status = 'running'
  `
}

/** Law 2 structural guard: the run-row error column (and through it the
 *  parent ledger + dashboard) only ever receives values from this fixed
 *  vocabulary — never a raw error message, which could embed tool output or
 *  task text if a future executor throws content-bearing errors. */
export function sanitizeExecutionError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (message.includes('encrypt') || message.includes('decrypt') || message.includes('key')) return 'encryption_failure'
    if (message.includes('timeout') || message.includes('deadline')) return 'deadline_exceeded'
    if (message.includes('cancel')) return 'cancelled'
    if (message.includes('gateway') || message.includes('model') || message.includes('ai run') || /\b5\d{3}\b/.test(message)) return 'model_call_failure'
    return `unexpected_error:${error.constructor.name}`
  }
  return 'unknown_error'
}

/** Empty chunk stream that closes when the run leaves 'running' (or the cap
 *  passes). The parent's warm fast path awaits this tail, so closing it is
 *  what triggers near-instant detached completion delivery. */
export function buildTerminalTailStream(
  sql: RunSql, runId: string, capMs: number, pollMs: number,
): ReadableStream<{ sequence: number; body: string }> {
  const cap = Date.now() + capMs
  return new ReadableStream({
    start: (controller) => {
      const poll = (): void => {
        const row = readRun(sql, runId)
        if (!row || row.status !== 'running' || Date.now() > cap) {
          controller.close()
          return
        }
        setTimeout(poll, pollMs)
      }
      poll()
    },
  })
}
