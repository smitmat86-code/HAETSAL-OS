// src/services/session/working-session.ts
// Phase 9 working-session context: a per-channel conversation window on the
// tenant DO. Message shapes follow the Agents SDK Sessions API (SessionMessage
// {id, role, parts}) so a later full Session/SessionProvider adoption is a
// drop-in; semantics here are linear (no branching — channels don't branch).
// Law 2: message parts rest TMK-encrypted in DO SQLite; ids/roles/timestamps
// are operational metadata. Sessions are NON-canonical — close summaries flow
// into canonical as evidence (close-summary.ts); raw turns never do.

import { decryptWithKek, encryptWithKek } from '../../cron/kek'

type SqlValue = string | number | boolean | null
export type SessionSql = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray, ...values: SqlValue[]
) => T[]

/** SDK-shaped message (agents experimental Sessions API compatible). */
export interface WorkingSessionMessage {
  id: string
  role: 'user' | 'assistant'
  parts: Array<{ type: 'text'; text: string }>
  createdAt?: Date
}

export const SESSION_WINDOW_LIMIT = 12
export const SESSION_IDLE_CLOSE_MS = 30 * 60_000
export const SESSION_CLOSE_AFTER_TURNS = 40

export function ensureSessionTables(sql: SessionSql): void {
  sql`
    CREATE TABLE IF NOT EXISTS haetsal_session_messages (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      parts_ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `
  sql`CREATE INDEX IF NOT EXISTS idx_session_messages_key_seq ON haetsal_session_messages(session_key, seq)`
  sql`
    CREATE TABLE IF NOT EXISTS haetsal_sessions (
      session_key TEXT PRIMARY KEY,
      turn_count INTEGER NOT NULL DEFAULT 0,
      close_schedule_id TEXT,
      last_activity_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `
}

export async function appendSessionMessage(
  sql: SessionSql, tmk: CryptoKey, sessionKey: string,
  role: WorkingSessionMessage['role'], text: string,
): Promise<{ turnCount: number }> {
  const now = Date.now()
  const seq = (sql<{ maxSeq: number | null }>`
    SELECT MAX(seq) AS maxSeq FROM haetsal_session_messages WHERE session_key = ${sessionKey}
  `[0]?.maxSeq ?? 0) + 1
  sql`
    INSERT INTO haetsal_session_messages (id, session_key, seq, role, parts_ciphertext, created_at)
    VALUES (${crypto.randomUUID()}, ${sessionKey}, ${seq}, ${role},
            ${await encryptWithKek(JSON.stringify([{ type: 'text', text }]), tmk)}, ${now})
  `
  sql`
    INSERT INTO haetsal_sessions (session_key, turn_count, last_activity_at, created_at)
    VALUES (${sessionKey}, 1, ${now}, ${now})
    ON CONFLICT(session_key) DO UPDATE SET
      turn_count = turn_count + 1, last_activity_at = ${now}
  `
  const turnCount = sql<{ turn_count: number }>`
    SELECT turn_count FROM haetsal_sessions WHERE session_key = ${sessionKey}
  `[0]?.turn_count ?? 1
  return { turnCount }
}

/** Byte-bounded recent window (windowed-read shape of the SDK provider). */
export async function readSessionWindow(
  sql: SessionSql, tmk: CryptoKey, sessionKey: string, limit = SESSION_WINDOW_LIMIT,
): Promise<WorkingSessionMessage[]> {
  const rows = sql<{ id: string; role: string; parts_ciphertext: string; created_at: number }>`
    SELECT id, role, parts_ciphertext, created_at FROM haetsal_session_messages
    WHERE session_key = ${sessionKey} ORDER BY seq DESC LIMIT ${limit}
  `
  const messages: WorkingSessionMessage[] = []
  for (const row of rows.reverse()) {
    try {
      const parts = JSON.parse(await decryptWithKek(row.parts_ciphertext, tmk)) as WorkingSessionMessage['parts']
      messages.push({ id: row.id, role: row.role as 'user' | 'assistant', parts, createdAt: new Date(row.created_at) })
    } catch { /* unreadable row (rotated key) — skip rather than fail the turn */ }
  }
  return messages
}

export function readSessionMeta(sql: SessionSql, sessionKey: string): {
  turnCount: number; closeScheduleId: string | null; lastActivityAt: number
} | null {
  const row = sql<{ turn_count: number; close_schedule_id: string | null; last_activity_at: number }>`
    SELECT turn_count, close_schedule_id, last_activity_at FROM haetsal_sessions WHERE session_key = ${sessionKey}
  `[0]
  return row ? { turnCount: row.turn_count, closeScheduleId: row.close_schedule_id, lastActivityAt: row.last_activity_at } : null
}

export function setCloseSchedule(sql: SessionSql, sessionKey: string, scheduleId: string | null): void {
  sql`UPDATE haetsal_sessions SET close_schedule_id = ${scheduleId} WHERE session_key = ${sessionKey}`
}

export function clearSession(sql: SessionSql, sessionKey: string): void {
  sql`DELETE FROM haetsal_session_messages WHERE session_key = ${sessionKey}`
  sql`DELETE FROM haetsal_sessions WHERE session_key = ${sessionKey}`
}

/** Render a window as a compact prompt block (transient plaintext). */
export function windowAsPromptBlock(messages: WorkingSessionMessage[]): string {
  return messages
    .map(m => `${m.role === 'user' ? 'User' : 'Haetsal'}: ${m.parts.map(p => p.text).join(' ').slice(0, 300)}`)
    .join('\n')
}
