import { handleMorningBrief } from '../../cron/morning-brief'
import { handleObsidianPoll } from '../../cron/obsidian-poll'
import { handleHindsightOperationsTick } from '../../cron/hindsight-operations'
import { runPredictiveHeartbeat } from '../../cron/heartbeat'
import { runWeeklySynthesis } from '../../cron/weekly-synthesis'
import { handleNightlyConsolidation } from '../../cron/consolidation'
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
      await Promise.allSettled([
        handleObsidianPoll(event, env, ctx),
        handleHindsightOperationsTick(env, ctx),
      ])
      return
    case '*/15 * * * *':
      return handleObsidianPoll(event, env, ctx)
    case '0 7 * * *':
      return handleMorningBrief(env, ctx)
    case '*/30 * * * *':
      return runPredictiveHeartbeat(env, ctx)
    case '0 17 * * 5':
      return runWeeklySynthesis(env, ctx)
    case '0 2 * * *':
      return handleNightlyConsolidation(env, ctx)
  }
}
