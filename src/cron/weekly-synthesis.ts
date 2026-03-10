// src/cron/weekly-synthesis.ts
// Friday 5PM weekly reflection — themes, decisions, one prediction
// Delivery: Telegram + Obsidian (NOT Pages notification)
// Archived as memory_type: 'semantic', provenance: 'weekly_synthesis'

import type { Env } from '../types/env'
import type { IngestionArtifact } from '../types/ingestion'
import { fetchAndValidateKek } from './kek'
import { sendTelegramMessage } from '../services/delivery/telegram'
import { writeToDriveBrainFolder } from '../services/delivery/obsidian-write'
import { recallViaService } from '../tools/recall'
import { retainContent } from '../services/ingestion/retain'
import { getGoogleToken } from '../services/google/oauth'

export async function runWeeklySynthesis(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const tenants = await env.D1_US.prepare(
    `SELECT id FROM tenants WHERE bootstrap_status = 'completed'`,
  ).all<{ id: string }>()

  if (!tenants.results?.length) return
  await Promise.allSettled(
    tenants.results.map(t => generateWeeklySynthesis(t.id, env, ctx)),
  )
}

async function generateWeeklySynthesis(
  tenantId: string, env: Env, ctx: ExecutionContext,
): Promise<void> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) return

  const sessions = await recallViaService(
    { query: 'session week review decisions themes patterns', limit: 20 },
    tenantId, kek, env,
  )

  if (!sessions.results.length) return

  const sessionText = sessions.results
    .slice(0, 10)
    .map(r => r.content.slice(0, 300))
    .join('\n\n---\n\n')

  // LLM synthesis via Workers AI with brain-gateway
  const ai = await env.AI.run(
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    {
      messages: [{
        role: 'user',
        content: `Review this week's sessions. Write a 200-word weekly synthesis.
Include: key themes, significant decisions, patterns noticed, one prediction for next week.
Be specific — no filler.\n\nSessions:\n${sessionText}`,
      }],
    },
    { gateway: { id: 'brain-gateway' } },
  ) as { response: string }

  const message = `<b>Week in Review</b>\n\n${ai.response}`

  // Deliver: Telegram + Obsidian (not Pages)
  await sendTelegramMessage(tenantId, message, env)

  const driveToken = await getGoogleToken(tenantId, 'drive', kek, env).catch(() => null)
  if (driveToken) {
    const md = `---\ngenerated_by: the-brain\ndate: ${new Date().toISOString()}\n---\n\n# Week in Review\n\n${ai.response}`
    const filename = `Weekly Synthesis ${new Date().toISOString().split('T')[0]}.md`
    ctx.waitUntil(writeToDriveBrainFolder(filename, md, driveToken).catch(() => {}))
  }

  // Archive as semantic memory
  const artifact: IngestionArtifact = {
    tenantId, source: 'mcp_retain', content: ai.response,
    occurredAt: Date.now(), memoryType: 'semantic',
    domain: 'general', provenance: 'weekly_synthesis',
    metadata: { is_weekly_synthesis: true },
  }
  ctx.waitUntil(retainContent(artifact, kek, env).catch(() => {}))
}
