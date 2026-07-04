// src/workers/mcpagent/do/automation-store.ts
// DO-SQLite persistence for user automations + their fire events. Law 2: the
// task text (user content) rests only as TMK ciphertext in spec_ciphertext;
// every other column is content-free operational metadata. Events power the
// dashboard automations panel, including Sendblue reply-window skips.

import type { RecurrenceKind } from '../../../services/automations/recurrence'

type SqlValue = string | number | boolean | null
export type AutoSql = <T = Record<string, SqlValue>>(
  strings: TemplateStringsArray, ...values: SqlValue[]
) => T[]

export interface AutomationRow {
  id: string
  kind: RecurrenceKind
  hour: number
  minute: number
  day_of_week: number | null
  tz: string
  profile: string
  reply_channel: string
  reply_to: string
  spec_ciphertext: string
  enabled: number
  schedule_id: string | null
  created_at: number
  last_fired_at: number | null
  last_status: string | null
}

export function ensureAutomationTables(sql: AutoSql): void {
  sql`
    CREATE TABLE IF NOT EXISTS haetsal_automations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      hour INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      day_of_week INTEGER,
      tz TEXT NOT NULL,
      profile TEXT NOT NULL,
      reply_channel TEXT NOT NULL,
      reply_to TEXT NOT NULL,
      spec_ciphertext TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_id TEXT,
      created_at INTEGER NOT NULL,
      last_fired_at INTEGER,
      last_status TEXT
    )
  `
  sql`
    CREATE TABLE IF NOT EXISTS haetsal_automation_events (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT
    )
  `
}

export function insertAutomation(sql: AutoSql, row: AutomationRow): void {
  sql`
    INSERT INTO haetsal_automations
      (id, kind, hour, minute, day_of_week, tz, profile, reply_channel, reply_to,
       spec_ciphertext, enabled, schedule_id, created_at)
    VALUES (${row.id}, ${row.kind}, ${row.hour}, ${row.minute}, ${row.day_of_week},
            ${row.tz}, ${row.profile}, ${row.reply_channel}, ${row.reply_to},
            ${row.spec_ciphertext}, ${row.enabled}, ${row.schedule_id}, ${row.created_at})
  `
}

export function listAutomationRows(sql: AutoSql): AutomationRow[] {
  return sql<AutomationRow>`
    SELECT id, kind, hour, minute, day_of_week, tz, profile, reply_channel, reply_to,
           spec_ciphertext, enabled, schedule_id, created_at, last_fired_at, last_status
    FROM haetsal_automations ORDER BY created_at DESC
  `
}

export function readAutomation(sql: AutoSql, id: string): AutomationRow | null {
  return sql<AutomationRow>`
    SELECT id, kind, hour, minute, day_of_week, tz, profile, reply_channel, reply_to,
           spec_ciphertext, enabled, schedule_id, created_at, last_fired_at, last_status
    FROM haetsal_automations WHERE id = ${id}
  `[0] ?? null
}

/** Resolve a chat-friendly id prefix to a full id (unique match required). */
export function resolveAutomationId(sql: AutoSql, idPrefix: string): string | null {
  const rows = sql<{ id: string }>`
    SELECT id FROM haetsal_automations WHERE id LIKE ${idPrefix + '%'} LIMIT 2
  `
  return rows.length === 1 ? rows[0].id : null
}

export function setAutomationEnabled(sql: AutoSql, id: string, enabled: boolean, scheduleId: string | null): void {
  sql`
    UPDATE haetsal_automations
    SET enabled = ${enabled ? 1 : 0}, schedule_id = ${scheduleId}
    WHERE id = ${id}
  `
}

export function setAutomationSchedule(sql: AutoSql, id: string, scheduleId: string | null): void {
  sql`UPDATE haetsal_automations SET schedule_id = ${scheduleId} WHERE id = ${id}`
}

export function recordFire(sql: AutoSql, id: string, status: string): void {
  sql`
    UPDATE haetsal_automations
    SET last_fired_at = ${Date.now()}, last_status = ${status}
    WHERE id = ${id}
  `
}

export function deleteAutomationRow(sql: AutoSql, id: string): void {
  sql`DELETE FROM haetsal_automations WHERE id = ${id}`
  sql`DELETE FROM haetsal_automation_events WHERE automation_id = ${id}`
}

export function insertAutomationEvent(
  sql: AutoSql, automationId: string, status: string, runId: string | null,
): void {
  sql`
    INSERT INTO haetsal_automation_events (id, automation_id, at, status, run_id)
    VALUES (${crypto.randomUUID()}, ${automationId}, ${Date.now()}, ${status}, ${runId})
  `
}

export function listAutomationEvents(sql: AutoSql, automationId: string, limit = 10): Array<{
  at: number; status: string; run_id: string | null
}> {
  return sql<{ at: number; status: string; run_id: string | null }>`
    SELECT at, status, run_id FROM haetsal_automation_events
    WHERE automation_id = ${automationId} ORDER BY at DESC LIMIT ${limit}
  `
}
