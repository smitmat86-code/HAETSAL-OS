// src/workers/mcpagent/do/session-runtime.ts
// DO-side working-session operations (Phase 9): record a channel exchange,
// (re)arm the idle-close alarm, close with an evidence summary. Sessions are
// keyed `<channel>:<peer>` (e.g. telegram:12345). Early close triggers when a
// session exceeds the turn ceiling so windows stay bounded.

import type { Env } from '../../../types/env'
import { closeSessionWithSummary } from '../../../services/session/close-summary'
import {
  appendSessionMessage, ensureSessionTables, readSessionMeta, readSessionWindow,
  setCloseSchedule, windowAsPromptBlock, SESSION_CLOSE_AFTER_TURNS, SESSION_IDLE_CLOSE_MS,
  type SessionSql, type WorkingSessionMessage,
} from '../../../services/session/working-session'

export interface SessionHost {
  env: Env
  sql: SessionSql
  tenantId: string | null
  tmk: CryptoKey | null
  schedule: (when: Date, callback: string, payload: unknown) => Promise<{ id: string }>
  cancelSchedule: (id: string) => Promise<boolean>
}

/** Record one user↔assistant exchange and manage the close lifecycle. */
export async function recordExchange(
  host: SessionHost,
  sessionKey: string,
  userText: string,
  assistantText: string,
): Promise<{ recorded: boolean }> {
  if (!host.tmk || !host.tenantId) return { recorded: false }
  ensureSessionTables(host.sql)
  await appendSessionMessage(host.sql, host.tmk, sessionKey, 'user', userText)
  const { turnCount } = await appendSessionMessage(host.sql, host.tmk, sessionKey, 'assistant', assistantText)

  if (turnCount >= SESSION_CLOSE_AFTER_TURNS) {
    await closeWorkingSession(host, sessionKey)
    return { recorded: true }
  }
  // Re-arm the idle-close alarm (replace any previous one).
  const meta = readSessionMeta(host.sql, sessionKey)
  if (meta?.closeScheduleId) await host.cancelSchedule(meta.closeScheduleId).catch(() => {})
  const schedule = await host.schedule(
    new Date(Date.now() + SESSION_IDLE_CLOSE_MS), 'closeIdleSession', { sessionKey },
  )
  setCloseSchedule(host.sql, sessionKey, schedule.id)
  return { recorded: true }
}

/** Window read for prompt assembly + the dashboard (transient plaintext). */
export async function sessionWindow(
  host: SessionHost, sessionKey: string, limit?: number,
): Promise<WorkingSessionMessage[]> {
  if (!host.tmk) return []
  ensureSessionTables(host.sql)
  return readSessionWindow(host.sql, host.tmk, sessionKey, limit)
}

export async function sessionWindowBlock(host: SessionHost, sessionKey: string): Promise<string> {
  return windowAsPromptBlock(await sessionWindow(host, sessionKey))
}

export async function closeWorkingSession(host: SessionHost, sessionKey: string): Promise<{ closed: boolean }> {
  if (!host.tmk || !host.tenantId) return { closed: false }
  ensureSessionTables(host.sql)
  const meta = readSessionMeta(host.sql, sessionKey)
  if (meta?.closeScheduleId) await host.cancelSchedule(meta.closeScheduleId).catch(() => {})
  await closeSessionWithSummary(host.env, host.sql, host.tmk, host.tenantId, sessionKey)
  return { closed: true }
}
