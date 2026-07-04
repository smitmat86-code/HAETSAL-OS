// src/services/dream/proposals.ts
// Findings → reviewable proposals in the canonical reviews table (T1 —
// plaintext authorized). REPORT-ONLY mode: nothing is auto-promoted; each
// proposal waits in the review inbox for the existing review/promotion path.
// Dedup: a stable subject id derived from the statement keeps re-runs from
// stacking duplicate pending reviews.

import type { Env } from '../../types/env'
import { getCanonicalGovernanceStore } from '../canonical-governance-postgres'
import type { DreamFinding, DreamFindings } from './types'

export const DREAM_REVIEW_TYPE = 'dream_proposal'

async function subjectIdFor(finding: DreamFinding): Promise<string> {
  const data = new TextEncoder().encode(`${finding.kind}|${finding.statement.toLowerCase()}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return 'dream-' + [...new Uint8Array(hash)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function allFindings(findings: DreamFindings): DreamFinding[] {
  return [
    ...findings.contradictions, ...findings.supersessions,
    ...findings.promotions, ...findings.entityLinks, ...findings.gaps,
  ]
}

/** Write pending reviews for every finding. Dedup scope is ALL dream reviews
 *  regardless of status: once Matt has decided a statement (approved or
 *  rejected), the same statement re-surfacing nightly is noise, not signal —
 *  a genuinely new development produces a different statement and a new hash. */
export async function writeDreamProposals(
  env: Env,
  tenantId: string,
  findings: DreamFindings,
): Promise<number> {
  const store = getCanonicalGovernanceStore(env)
  const existing = [
    ...await store.listReviews(tenantId, 'pending', 200),
    ...await store.listReviews(tenantId, 'approved', 200),
    ...await store.listReviews(tenantId, 'rejected', 200),
  ]
  const pendingSubjects = new Set(existing.filter(r => r.review_type === DREAM_REVIEW_TYPE).map(r => r.subject_id))
  let written = 0
  for (const finding of allFindings(findings)) {
    const subjectId = await subjectIdFor(finding)
    if (pendingSubjects.has(subjectId)) continue
    await store.createReview({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      review_type: DREAM_REVIEW_TYPE,
      subject_kind: finding.kind,
      subject_id: subjectId,
      proposal_json: JSON.stringify({
        statement: finding.statement,
        rationale: finding.rationale,
        confidence: finding.confidence,
        refs: finding.refs,
      }),
      status: 'pending',
      created_at: Date.now(),
      decided_at: null,
      decided_by: null,
      decision_note: null,
    })
    pendingSubjects.add(subjectId)
    written++
  }
  return written
}
