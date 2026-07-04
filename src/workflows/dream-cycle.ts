// src/workflows/dream-cycle.ts
// Phase 8 nightly dream cycle as a durable Workflow (C4). Report-only mode:
// findings become pending reviews + a canonical report — never silent
// mutations, no auto-promotion. Law 2 discipline for Workflows: step.do()
// RETURN VALUES are persisted by the Workflows engine, so steps return only
// ids and counts; tenant content stays inside a step's memory (stage.ts) and
// lands only in canonical Postgres. Cron-context content writes use the
// time-bound Cron KEK; a missing/expired KEK DEFERS the cycle honestly.

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import type { Env } from '../types/env'
import { executeDreamStage, type DreamStageResult } from '../services/dream/stage'
import { finishDreamRun } from '../services/dream/report'
import { runDecayPass } from '../services/decay/pass'
import { writeAuditLog } from '../middleware/audit'

export interface DreamCycleParams {
  tenantId: string
  runId: string
  runDate: string
}

export class DreamCycleWorkflow extends WorkflowEntrypoint<Env, DreamCycleParams> {
  async run(event: WorkflowEvent<DreamCycleParams>, step: WorkflowStep) {
    const { tenantId, runId, runDate } = event.payload
    const env = this.env

    // Phase 12: metadata-only decay pass — needs no key material, so it runs
    // even on nights the content stage defers on a missing KEK. A decay
    // failure is an audit note, never a cycle-stopper (own catch: an
    // exhausted step throws into the body and would otherwise kill the run).
    try {
      await step.do('dream-decay-pass', {
        retries: { limit: 1, delay: '15 seconds', backoff: 'constant' },
        timeout: '3 minutes',
      }, async () => { await runDecayPass(env, tenantId) })
    } catch {
      await step.do('dream-decay-failed-note', async () => {
        await writeAuditLog(env, 'decay.pass_failed', tenantId, { agentIdentity: 'consolidation_cron' })
      })
    }

    try {
      const outcome: DreamStageResult = await step.do('dream-extract-propose-report', {
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
        timeout: '10 minutes',
        sensitive: 'output', // defense-in-depth: keep even content-free returns out of Workflows logs
      }, async () => executeDreamStage(env, tenantId, runDate))

      await step.do('dream-record-run', async () => {
        if (outcome.deferred) {
          // KEK expired/missing: the kek helper already wrote the anomaly
          // signal; the run is recorded and the NEXT cycle (post-auth) works.
          await finishDreamRun(env, runId, { status: 'failed', error: 'deferred_kek_unavailable' })
          await writeAuditLog(env, 'dream_cycle.deferred', tenantId, { agentIdentity: 'consolidation_cron' })
          return
        }
        await finishDreamRun(env, runId, {
          status: 'completed',
          counts: outcome.counts,
          captureId: outcome.captureId,
          documentId: outcome.documentId,
        })
        await writeAuditLog(env, 'dream_cycle.completed', tenantId, { agentIdentity: 'consolidation_cron' })
      })
    } catch (error) {
      await step.do('dream-record-failure', async () => {
        await finishDreamRun(env, runId, {
          status: 'failed',
          // Fixed vocabulary only (Law 2): a raw store/AI error message could
          // theoretically echo content into the D1 error column.
          error: `dream_cycle_failed:${error instanceof Error ? error.constructor.name : 'unknown'}`,
        })
        await writeAuditLog(env, 'dream_cycle.failed', tenantId, { agentIdentity: 'consolidation_cron' })
      })
    }
  }
}
