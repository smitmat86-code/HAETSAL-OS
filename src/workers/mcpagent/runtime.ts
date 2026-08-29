import { handleMorningBrief } from '../../cron/morning-brief'
import { handleObsidianPoll } from '../../cron/obsidian-poll'
import { runPredictiveHeartbeat } from '../../cron/heartbeat'
import { runWeeklySynthesis } from '../../cron/weekly-synthesis'
import { handleDreamCron } from '../../cron/dream'
import { runCanaryCron } from '../../cron/canary'
import type { ActionQueueMessage } from '../../types/action'
import type { Env } from '../../types/env'
import type { IngestionQueueMessage } from '../../types/ingestion'
import { handleActionBatch } from '../action/index'
import { handleIngestionBatch } from '../ingestion/consumer'
import { reapExpiredChannelMediaJobs } from '../../services/channel-media/reaper'
import { reapExpiredArtifactUploads } from '../../services/artifact-intake/reaper'

export async function handleBrainQueue(
  batch: MessageBatch<ActionQueueMessage | IngestionQueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (batch.queue === 'brain-actions') {
    await handleActionBatch(batch as MessageBatch<ActionQueueMessage>, env, ctx)
    return
  }
  await handleIngestionBatch(batch as MessageBatch<IngestionQueueMessage>, env, ctx)
}

export async function handleBrainScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  switch (event.cron) {
    case '*/1 * * * *':
      return handleObsidianPoll(event, env, ctx)
    case '*/15 * * * *':
      // Phase 13: hourly canary sweep piggybacks the 15-min slot.
      ctx.waitUntil(runCanaryCron(env))
      ctx.waitUntil(reapExpiredChannelMediaJobs(env))
      // Artifact upload reaper: every 15 minutes, bounded batch, isolated so
      // a failure can never affect the other jobs sharing this slot. Its
      // result is aggregate counts only; nothing content-bearing is logged.
      ctx.waitUntil(reapExpiredArtifactUploads(env).catch(() => undefined))
      return handleObsidianPoll(event, env, ctx)
    case '0 7 * * *':
      return handleMorningBrief(env, ctx)
    case '*/30 * * * *':
      return runPredictiveHeartbeat(env, ctx)
    case '0 17 * * 5':
      return runWeeklySynthesis(env, ctx)
    case '0 2 * * *':
      // Phase 8: dream cycle replaces the parked pass-1..4 consolidation.
      return handleDreamCron(env, ctx)
  }
}
