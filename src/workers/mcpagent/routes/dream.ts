// src/workers/mcpagent/routes/dream.ts
// Phase 8 dream-cycle surface (CF Access): manual trigger for the gate smoke
// + latest run/report + pending review inbox (consumed by the Phase 11
// consolidation panel). Report body decrypt-reads require the caller's
// derived tenant key, same as the approval route precedent.

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import { fetchAndValidateKek } from '../../../cron/kek'
import { startDreamRun } from '../../../cron/dream'
import { latestDreamRun } from '../../../services/dream/report'
import { DREAM_REVIEW_TYPE } from '../../../services/dream/proposals'
import { getCanonicalDocument } from '../../../services/canonical-memory-query'
import { getCanonicalGovernanceStore } from '../../../services/canonical-governance-postgres'
import { decaySummary, runDecayPass } from '../../../services/decay/pass'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const dream = new Hono<{ Bindings: Env; Variables: Variables }>()

dream.post('/run', async (c) => {
  const result = await startDreamRun(c.get('tenantId'), 'manual', c.env)
  return c.json(result, result.started ? 202 : 409)
})

dream.get('/latest', async (c) => {
  const tenantId = c.get('tenantId')
  // Any terminal run (incl. failed/deferred) — the smoke and the dashboard
  // need failure visibility; the morning brief separately reads completedOnly.
  const run = await latestDreamRun(c.env, tenantId, { completedOnly: false })
  if (!run) return c.json({ run: null, report: null })
  let report: string | null = null
  if (run.report_document_id) {
    try {
      // The report body sidecar is Cron-KEK-encrypted (cron-context write) —
      // the KEK is a random key, NOT the derived session TMK (proven at the
      // Phase 8 gate). Read with the same key family that wrote it.
      const kek = await fetchAndValidateKek(tenantId, c.env)
      if (kek) {
        const doc = await getCanonicalDocument(
          { tenantId, documentId: run.report_document_id }, c.env, tenantId, { tmk: kek },
        )
        report = doc.body
      }
    } catch { report = null }
  }
  return c.json({ run, report })
})

dream.get('/reviews', async (c) => {
  const store = getCanonicalGovernanceStore(c.env)
  const status = (c.req.query('status') ?? 'pending') as 'pending' | 'approved' | 'rejected'
  const reviews = await store.listReviews(c.get('tenantId'), status, 50)
  return c.json(reviews.filter(r => r.review_type === DREAM_REVIEW_TYPE).map(r => ({
    id: r.id,
    kind: r.subject_kind,
    subjectId: r.subject_id,
    proposal: safeParse(r.proposal_json),
    status: r.status,
    createdAt: r.created_at,
  })))
})

// Phase 12: metadata-only decay pass (fixture-gated; nightly via the dream workflow).
dream.post('/decay/run', async (c) => c.json(await runDecayPass(c.env, c.get('tenantId')), 202))
dream.get('/decay/summary', async (c) => c.json(await decaySummary(c.env, c.get('tenantId'))))

function safeParse(json: string): unknown {
  try { return JSON.parse(json) } catch { return null }
}
