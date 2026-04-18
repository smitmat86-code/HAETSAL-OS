// src/cron/morning-brief.ts
// Morning brief assembly + delivery (7 sections, 3 channels)
// LESSON: Promise.allSettled — each section fails independently
// LESSON: KEK expired → defer entire brief, not fail

import type { Env } from '../types/env'
import type { IngestionArtifact } from '../types/ingestion'
import { fetchAndValidateKek } from './kek'
import { sendTelegramMessage } from '../services/delivery/telegram'
import { writeToDriveBrainFolder } from '../services/delivery/obsidian-write'
import { retainContent } from '../services/ingestion/retain'
import { getGoogleToken } from '../services/google/oauth'
import { getMcpAgentObjectName } from '../workers/mcpagent/do/identity'
import {
  fetchCalendar, fetchPending, fetchHighlights, fetchOpenLoop,
  fetchGift, fetchNews, fetchVerse,
} from './brief-sections'

// ── Assembly + Delivery ────────────────────────────────────────────────────

export async function handleMorningBrief(env: Env, ctx: ExecutionContext): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()
  if (!tenants.results?.length) return
  await Promise.allSettled(tenants.results.map(t => buildAndDeliver(t.id, env, ctx)))
}

async function buildAndDeliver(
  tenantId: string, env: Env, ctx: ExecutionContext,
): Promise<void> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) return

  const [cal, pend, hl, loop, gift, news, verse] = await Promise.allSettled([
    fetchCalendar(tenantId, kek, env), fetchPending(tenantId, env),
    fetchHighlights(tenantId, kek, env), fetchOpenLoop(tenantId, env),
    fetchGift(tenantId, kek, env), fetchNews(env), fetchVerse(env),
  ])

  const r = <T>(s: PromiseSettledResult<T>, fb: T): T =>
    s.status === 'fulfilled' ? s.value : fb

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const parts: string[] = [`<b>Good morning — ${today}</b>`, '', '<b>Today</b>', r(cal, '_Calendar unavailable_')]

  const pendStr = r(pend, '');    if (pendStr) parts.push('', '<b>Pending Your Approval</b>', pendStr)
  const hlStr = r(hl, '');        if (hlStr) parts.push('', '<b>From Your Brain</b>', hlStr)
  const loopStr = r(loop, '');    if (loopStr) parts.push('', '<b>Open Loop</b>', loopStr)
  const giftStr = r(gift, '');    if (giftStr) parts.push('', '<b>Something Interesting</b>', giftStr)
  parts.push('', '<b>News</b>', r(news, '_News unavailable_'))
  const verseStr = r(verse, '');  if (verseStr) parts.push('', verseStr)

  const brief = parts.join('\n')
  const mdBrief = brief.replace(/<\/?b>/g, '**').replace(/<[^>]+>/g, '')

  // 1. Telegram (primary)
  await sendTelegramMessage(tenantId, brief, env)

  // 2. Pages UI broadcast (non-fatal on cold DO)
  try {
    const stub = env.MCPAGENT.get(env.MCPAGENT.idFromName(getMcpAgentObjectName(tenantId)))
    // @ts-expect-error DO RPC
    await stub.broadcast({ type: 'brief.morning', content: brief, delivered_at: Date.now() })
  } catch { /* cold DO — expected */ }

  // 3. Obsidian Drive write (non-fatal)
  const driveToken = await getGoogleToken(tenantId, 'drive', kek, env).catch(() => null)
  if (driveToken) {
    const fn = `Daily Brief ${new Date().toISOString().split('T')[0]}.md`
    const md = `---\ngenerated_by: the-brain\ndate: ${new Date().toISOString()}\n---\n\n${mdBrief}`
    ctx.waitUntil(writeToDriveBrainFolder(fn, md, driveToken).catch(() => {}))
  }

  // 4. Archive to Hindsight (non-blocking)
  const artifact: IngestionArtifact = {
    tenantId, source: 'mcp_retain', content: mdBrief,
    occurredAt: Date.now(), memoryType: 'episodic', domain: 'general',
    provenance: 'morning_brief', metadata: { is_brief: true },
  }
  ctx.waitUntil(retainContent(artifact, kek, env).catch(() => {}))

  // 5. Mark open loop gap as surfaced
  if (loop.status === 'fulfilled' && loop.value) {
    ctx.waitUntil(env.D1_US.prepare(
      `UPDATE consolidation_gaps SET surfaced = 1
       WHERE tenant_id = ? AND surfaced = 0 AND priority = 'high'
       AND rowid = (SELECT rowid FROM consolidation_gaps
       WHERE tenant_id = ? AND surfaced = 0 AND priority = 'high'
       ORDER BY created_at ASC LIMIT 1)`,
    ).bind(tenantId, tenantId).run().catch(() => {}))
  }
}
