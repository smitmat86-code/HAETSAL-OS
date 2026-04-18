// src/cron/weekly-synthesis.ts
// Friday 5PM weekly reflection delivered via Telegram + Drive and archived back into memory.

import type { Env } from '../types/env'
import type { IngestionArtifact } from '../types/ingestion'
import { reflectMemory } from '../services/hindsight'
import { fetchAndValidateKek } from './kek'
import { sendTelegramMessage } from '../services/delivery/telegram'
import { writeToDriveBrainFolder } from '../services/delivery/obsidian-write'
import { retainContent } from '../services/ingestion/retain'
import { getGoogleToken } from '../services/google/oauth'

export const WEEKLY_SYNTHESIS_REFLECT_QUERY = `Review this week's sessions and retained memories. Write a 200-word weekly synthesis.
Include: key themes, significant decisions, patterns noticed, and one grounded prediction for next week.
Be specific and concrete. Avoid filler.`

export const WEEKLY_SYNTHESIS_REFLECT_TAGS_MATCH = 'all_strict'
export const WEEKLY_SYNTHESIS_REFLECT_BUDGET = 'high'

export async function runWeeklySynthesis(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()

  if (!tenants.results?.length) return
  await Promise.allSettled(
    tenants.results.map(tenant => generateWeeklySynthesis(tenant.id, env, ctx)),
  )
}

async function generateWeeklySynthesis(
  tenantId: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) return

  const reflection = await reflectMemory(tenantId, {
    query: WEEKLY_SYNTHESIS_REFLECT_QUERY,
    budget: WEEKLY_SYNTHESIS_REFLECT_BUDGET,
    tags: [`tenant:${tenantId}`],
    tags_match: WEEKLY_SYNTHESIS_REFLECT_TAGS_MATCH,
  }, env).catch(() => null)

  const synthesis = reflection?.text?.trim()
  if (!synthesis) return

  await sendTelegramMessage(tenantId, `<b>Week in Review</b>\n\n${synthesis}`, env)

  const driveToken = await getGoogleToken(tenantId, 'drive', kek, env).catch(() => null)
  if (driveToken) {
    const md = `---\ngenerated_by: the-brain\ndate: ${new Date().toISOString()}\n---\n\n# Week in Review\n\n${synthesis}`
    const filename = `Weekly Synthesis ${new Date().toISOString().split('T')[0]}.md`
    ctx.waitUntil(writeToDriveBrainFolder(filename, md, driveToken).catch(() => {}))
  }

  const artifact: IngestionArtifact = {
    tenantId,
    source: 'mcp_retain',
    content: synthesis,
    occurredAt: Date.now(),
    memoryType: 'semantic',
    domain: 'general',
    provenance: 'weekly_synthesis',
    metadata: { is_weekly_synthesis: true },
  }
  ctx.waitUntil(retainContent(artifact, kek, env).catch(() => {}))
}
