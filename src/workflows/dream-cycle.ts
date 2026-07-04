// src/workflows/dream-cycle.ts
// Phase 8 nightly dream cycle as a durable Workflow (C4). Report-only mode:
// findings become pending reviews + a canonical report — never silent
// mutations, no auto-promotion. Law 2 discipline for Workflows: step.do()
// RETURN VALUES are persisted by the Workflows engine, so steps return only
// ids and counts; tenant content stays inside a step's memory and lands only
// in canonical Postgres (authorized boundary).

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import type { Env } from '../types/env'
import { listRecentCanonicalMemories } from '../services/canonical-memory-query'
import { getCanonicalGovernanceStore } from '../services/canonical-governance-postgres'
import { buildWindowBlock, extractDreamFindings, type DreamWindowItem } from '../services/dream/extract'
import { writeDreamProposals } from '../services/dream/proposals'
import { composeDreamReport, finishDreamRun, persistDreamReport } from '../services/dream/report'
import { DREAM_WINDOW_EVENT_LIMIT, type DreamCounts } from '../services/dream/types'
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

    try {
      // Single content-bearing stage: read window → extract → file proposals →
      // compose + persist the report. All inside ONE step so no tenant content
      // crosses a step boundary; the persisted step result is counts/ids only.
      const outcome = await step.do('dream-extract-propose-report', {
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
        timeout: '10 minutes',
        sensitive: 'output', // defense-in-depth: keep even content-free returns out of Workflows logs
      }, async (): Promise<{ counts: DreamCounts; captureId: string | null; documentId: string | null }> => {
        const recent = await listRecentCanonicalMemories(
          { tenantId, limit: DREAM_WINDOW_EVENT_LIMIT }, env, tenantId,
        )
        const items: DreamWindowItem[] = recent.items
          .filter(item => item.sourceSystem !== 'cron:dream') // never dream about dream reports
          .map((item, index) => ({
            ref: item.captureId?.slice(0, 8) ?? `item-${index}`,
            when: item.capturedAt ?? Date.now(),
            text: item.preview || item.title || '',
          }))
          .filter(item => item.text.length > 0)

        const store = getCanonicalGovernanceStore(env)
        const edges = await store.listEdgesWithEntities(tenantId, 30)
        const edgesBlock = edges
          .map(edge => `${edge.src_name} —${edge.edge_type}→ ${edge.dst_name}`)
          .join('\n').slice(0, 2000)

        const findings = items.length > 0
          ? await extractDreamFindings(env, buildWindowBlock(items), edgesBlock)
          : { facts: [], contradictions: [], supersessions: [], promotions: [], entityLinks: [], gaps: [] }

        const proposalsWritten = await writeDreamProposals(env, tenantId, findings)
        const counts: DreamCounts = {
          eventsSeen: items.length,
          proposalsWritten,
          contradictions: findings.contradictions.length,
          supersessions: findings.supersessions.length,
          promotions: findings.promotions.length,
          gaps: findings.gaps.length,
        }
        const report = composeDreamReport(runDate, findings, counts)
        const persisted = await persistDreamReport(env, tenantId, report, runDate)
        return { counts, ...persisted }
      })

      await step.do('dream-record-run', async () => {
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
