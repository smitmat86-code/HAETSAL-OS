// src/services/session/close-summary.ts
// Session close: summarize the working window (MODEL_CHAT via gateway,
// collectLog:false) and flow the summary into canonical Postgres as an
// EVIDENCE-grade capture (mission Phase 9: "sessions non-canonical; close
// summaries flow into canonical as evidence"). Then clear the window.

import type { Env } from '../../types/env'
import { MODEL_CHAT } from '../../config/models'
import { retainContent } from '../ingestion/retain'
import { writeAuditLog } from '../../middleware/audit'
import {
  clearSession, readSessionWindow, windowAsPromptBlock, type SessionSql,
} from './working-session'

export async function closeSessionWithSummary(
  env: Env,
  sql: SessionSql,
  tmk: CryptoKey,
  tenantId: string,
  sessionKey: string,
): Promise<{ closed: boolean; captureId: string | null }> {
  const window = await readSessionWindow(sql, tmk, sessionKey, 40)
  if (window.length === 0) {
    clearSession(sql, sessionKey)
    return { closed: true, captureId: null }
  }
  const transcriptBlock = windowAsPromptBlock(window)
  let summary: string | null = null
  try {
    const result = await (env.AI as { run: (m: string, i: unknown, o?: unknown) => Promise<unknown> }).run(
      MODEL_CHAT,
      {
        messages: [
          { role: 'system', content: 'Summarize this chat session between the user and their assistant in 2-5 factual sentences: decisions made, facts shared, tasks started, open threads. No preamble.' },
          { role: 'user', content: transcriptBlock.slice(0, 6000) },
        ],
        max_tokens: 300,
      },
      { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } },
    )
    const r = result as { response?: string; choices?: Array<{ message?: { content?: string } }> }
    summary = (typeof r?.choices?.[0]?.message?.content === 'string' ? r.choices[0].message!.content : r?.response)?.trim() ?? null
  } catch { summary = null }

  // Honest fallback: a session that cannot be summarized still leaves
  // evidence — the first/last user turns, clearly labeled.
  const content = summary && summary.length > 10
    ? `Session summary (${sessionKey.split(':')[0]}): ${summary}`
    : `Session closed (${sessionKey.split(':')[0]}) — ${window.length} turns; summary unavailable. First: "${window[0].parts[0]?.text.slice(0, 120)}"`

  const result = await retainContent({
    tenantId,
    content,
    source: `session:${sessionKey.split(':')[0]}`,
    sourceRef: sessionKey,
    memoryType: 'episodic',
    domain: 'general',
    provenance: 'session_close_summary',
    occurredAt: Date.now(),
  }, tmk, env)
  clearSession(sql, sessionKey)
  void writeAuditLog(env, 'session.closed', tenantId, { agentIdentity: 'session_manager' })
  return { closed: true, captureId: result?.canonicalCaptureId ?? null }
}
