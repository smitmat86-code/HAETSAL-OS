// src/cron/obsidian-poll.ts
// Obsidian cron polling — extracted from index.ts scheduled() handler
// */1: /to-brain/ folder check, */15: vault-wide brain:true scan

import type { Env } from '../types/env'
import type { IngestionQueueMessage } from '../types/ingestion'

export async function handleObsidianPoll(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE obsidian_sync_enabled = 1`,
  ).all<{ id: string }>()

  if (!tenants.results?.length) return

  for (const tenant of tenants.results) {
    const lastPollKey = `obsidian_last_poll:${tenant.id}`
    const lastPoll = await env.KV_SESSION.get(lastPollKey)
    const lastPollMs = lastPoll ? parseInt(lastPoll, 10) : 0

    // Skip if polled within the last 55 seconds (1-min cron safety)
    if (event.cron === '*/1 * * * *' && Date.now() - lastPollMs < 55_000) continue

    const message: IngestionQueueMessage = {
      type: 'obsidian_note',
      tenantId: tenant.id,
      payload: {
        pollType: event.cron === '*/1 * * * *' ? 'folder' : 'vault_scan',
        sinceMs: lastPollMs,
      },
      enqueuedAt: Date.now(),
    }

    ctx.waitUntil(env.QUEUE_NORMAL.send(message))
    ctx.waitUntil(env.KV_SESSION.put(lastPollKey, String(Date.now())))
  }
}
