// src/cron/weekly-synthesis.ts
// Friday 5PM weekly reflection — Phase 2: Hindsight /reflect retired.
// WEEKLY_SYNTHESIS_REFLECT_RETIRED_PENDING_PHASE8

import type { Env } from '../types/env'

export const WEEKLY_SYNTHESIS_REFLECT_QUERY = `Review this week's sessions and retained memories. Write a 200-word weekly synthesis.
Include: key themes, significant decisions, patterns noticed, and one grounded prediction for next week.
Be specific and concrete. Avoid filler.`

export const WEEKLY_SYNTHESIS_REFLECT_TAGS_MATCH = 'all_strict'
export const WEEKLY_SYNTHESIS_REFLECT_BUDGET = 'high'

export async function runWeeklySynthesis(
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log('WEEKLY_SYNTHESIS_REFLECT_RETIRED_PENDING_PHASE8')
}
