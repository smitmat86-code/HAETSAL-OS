// src/services/dream/stage.ts
// The dream cycle's single content-bearing stage, extracted from the Workflow
// for unit testing and the file line limit. Cron-context content writes need
// the time-bound Cron KEK (Law 2 corollary) — the report's archival sidecar
// is tenant-encrypted with it. Expired/missing KEK → DEFER honestly (the KEK
// helper already writes the anomaly signal); proposals and reports wait for
// the next cycle after Matt authenticates. Never bypass.

import type { Env } from '../../types/env'
import { fetchAndValidateKek } from '../../cron/kek'
import { getCanonicalGovernanceStore } from '../canonical-governance-postgres'
import { listRecentCanonicalMemories } from '../canonical-memory-query'
import { buildWindowBlock, extractDreamFindings, type DreamWindowItem } from './extract'
import { writeDreamProposals } from './proposals'
import { composeDreamReport, persistDreamReport } from './report'
import { DREAM_WINDOW_EVENT_LIMIT, type DreamCounts } from './types'

export type DreamStageResult =
  | { deferred: true }
  | { deferred: false; counts: DreamCounts; captureId: string | null; documentId: string | null }

export async function executeDreamStage(
  env: Env,
  tenantId: string,
  runDate: string,
): Promise<DreamStageResult> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) return { deferred: true }

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
  const persisted = await persistDreamReport(env, tenantId, report, runDate, kek)
  return { deferred: false, counts, ...persisted }
}
