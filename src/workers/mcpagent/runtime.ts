import { handleMorningBrief } from '../../cron/morning-brief'
import { handleObsidianPoll } from '../../cron/obsidian-poll'
import { runPredictiveHeartbeat } from '../../cron/heartbeat'
import { runWeeklySynthesis } from '../../cron/weekly-synthesis'
import { handleDreamCron } from '../../cron/dream'
import type { ActionQueueMessage } from '../../types/action'
import type { Env } from '../../types/env'
import type { IngestionQueueMessage } from '../../types/ingestion'
import { handleActionBatch } from '../action/index'
import { handleIngestionBatch } from '../ingestion/consumer'

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
