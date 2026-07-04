// src/workers/mcpagent/do/automation-view.ts
// List view over automations for chat replies, MCP tools, and the dashboard.
// The task text decrypts transiently for the response only — it stays TMK
// ciphertext at rest (Law 2). Split from automation-runtime.ts (line limit).

import type { Env } from '../../../types/env'
import { decryptWithKek } from '../../../cron/kek'
import { describeRecurrence, nextOccurrence } from '../../../services/automations/recurrence'
import { listAutomationEvents, listAutomationRows, type AutoSql } from './automation-store'
import { specOf, type AutomationHost, type AutomationView } from './automation-runtime'

/** Default delivery route for MCP-created automations: the tenant's first
 *  registered Telegram chat (the reliable channel; empty = ledger-only). */
export async function defaultAutomationRoute(env: Env, tenantId: string): Promise<{
  channel: 'telegram'; replyTo: string
}> {
  const row = await env.D1_US.prepare(
    'SELECT chat_id FROM telegram_chats WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1',
  ).bind(tenantId).first<{ chat_id: number }>().catch(() => null)
  return { channel: 'telegram', replyTo: row ? String(row.chat_id) : '' }
}

export async function listAutomationsView(host: AutomationHost): Promise<AutomationView[]> {
  const sql = host.sql as AutoSql
  const rows = listAutomationRows(sql)
  const views: AutomationView[] = []
  for (const row of rows) {
    let task = '(locked — session key unavailable)'
    if (host.tmk) {
      task = await decryptWithKek(row.spec_ciphertext, host.tmk)
        .then(json => (JSON.parse(json) as { task: string }).task)
        .catch(() => '(unreadable)')
    }
    views.push({
      id: row.id, idShort: row.id.slice(0, 8), task,
      schedule: describeRecurrence(specOf(row)),
      enabled: row.enabled === 1,
      nextFireAt: row.enabled === 1 ? nextOccurrence(specOf(row), Date.now()) : null,
      lastFiredAt: row.last_fired_at, lastStatus: row.last_status,
      events: listAutomationEvents(sql, row.id, 5),
    })
  }
  return views
}
