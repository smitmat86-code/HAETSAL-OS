// src/workers/mcpagent/do/agent-task-store.ts
// Parent-DO ledger for dispatched execution tasks. Sits beside the SDK's
// cf_agent_tool_runs table in the same SQLite; holds what the framework row
// cannot: the TMK-encrypted task spec (for retry), the reply route, retry
// lineage, and the delivery-claim flags that make onFinish idempotent.

type SqlValue = string | number | boolean | null
export type TaskSql = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray, ...values: SqlValue[]
) => T[]

export interface AgentTaskRow {
  run_id: string
  profile: string
  tools_json: string
  task_ciphertext: string
  reply_channel: string
  reply_to: string
  retry_of: string | null
  origin: string | null
  created_at: number
  delivered_final: number
  delivered_giveup: number
}

export interface TaskRecord {
  runId: string
  profile: string
  tools: string[]
  taskCiphertext: string
  replyChannel: string
  replyTo: string
  retryOf: string | null
  /** Content-free provenance tag, e.g. 'automation:<id>' (Phase 7). */
  origin: string | null
}

export function ensureTaskTable(sql: TaskSql): void {
  sql`
    CREATE TABLE IF NOT EXISTS haetsal_agent_tasks (
      run_id TEXT PRIMARY KEY,
      profile TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      task_ciphertext TEXT NOT NULL,
      reply_channel TEXT NOT NULL,
      reply_to TEXT NOT NULL,
      retry_of TEXT,
      origin TEXT,
      created_at INTEGER NOT NULL,
      delivered_final INTEGER NOT NULL DEFAULT 0,
      delivered_giveup INTEGER NOT NULL DEFAULT 0
    )
  `
  // Phase 7 forward-migration for tables created by the Phase 6 deploy.
  try { sql`ALTER TABLE haetsal_agent_tasks ADD COLUMN origin TEXT` } catch { /* exists */ }
}

export function insertTaskRow(sql: TaskSql, record: TaskRecord): void {
  sql`
    INSERT INTO haetsal_agent_tasks
      (run_id, profile, tools_json, task_ciphertext, reply_channel, reply_to, retry_of, origin, created_at)
    VALUES (${record.runId}, ${record.profile}, ${JSON.stringify(record.tools)},
            ${record.taskCiphertext}, ${record.replyChannel}, ${record.replyTo},
            ${record.retryOf}, ${record.origin}, ${Date.now()})
    ON CONFLICT(run_id) DO NOTHING
  `
}

export function readTaskRow(sql: TaskSql, runId: string): TaskRecord | null {
  const row = sql<AgentTaskRow>`
    SELECT run_id, profile, tools_json, task_ciphertext, reply_channel, reply_to,
           retry_of, origin, created_at, delivered_final, delivered_giveup
    FROM haetsal_agent_tasks WHERE run_id = ${runId}
  `[0]
  if (!row) return null
  return {
    runId: row.run_id,
    profile: row.profile,
    tools: parseTools(row.tools_json),
    taskCiphertext: row.task_ciphertext,
    replyChannel: row.reply_channel,
    replyTo: row.reply_to,
    retryOf: row.retry_of,
    origin: row.origin,
  }
}

/** Claim one delivery slot. The 'final' claim also closes the giveup slot so
 *  a real result never gets followed by a stale timeout note. Returns whether
 *  the caller won the claim. */
export function claimDelivery(sql: TaskSql, runId: string, slot: 'final' | 'giveup'): boolean {
  if (slot === 'final') {
    const rows = sql<{ run_id: string }>`
      UPDATE haetsal_agent_tasks
      SET delivered_final = 1, delivered_giveup = 1
      WHERE run_id = ${runId} AND delivered_final = 0
      RETURNING run_id
    `
    return rows.length > 0
  }
  const rows = sql<{ run_id: string }>`
    UPDATE haetsal_agent_tasks
    SET delivered_giveup = 1
    WHERE run_id = ${runId} AND delivered_giveup = 0 AND delivered_final = 0
    RETURNING run_id
  `
  return rows.length > 0
}

function parseTools(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch { return [] }
}
