import type { Env } from '../types/env'
import type { CanonicalTrustState } from '../types/canonical-governance'
import type { CanonicalFactRecord } from '../types/canonical-governance-records'
import { getCanonicalGovernanceStore } from './canonical-governance-postgres'

export interface PromoteClaimInput {
  tenantId: string
  claimId: string
  promotedBy: 'policy' | 'review' | 'user'
  /** Required when promotedBy is 'review'; must reference an approved review. */
  reviewId?: string | null
  /** Trust state granted by the promotion. */
  trustState?: Extract<CanonicalTrustState, 'user_confirmed' | 'trusted_import'>
  actorIdentity?: string | null
}

/**
 * Promote a claim to a fact. Agent-written memory defaults to evidence-only;
 * this is the ONLY path to instruction-grade trust (HAETSAL_MISSION.md Phase 1:
 * "Promotion requires policy or review").
 */
export async function promoteClaim(input: PromoteClaimInput, env: Env): Promise<CanonicalFactRecord> {
  const store = getCanonicalGovernanceStore(env)
  const claim = await store.getClaim(input.tenantId, input.claimId)
  if (!claim) throw new Error(`Unknown claim for promotion: ${input.claimId}`)
  if (claim.trust_state === 'rejected' || claim.trust_state === 'superseded') {
    throw new Error(`Claim ${input.claimId} is ${claim.trust_state}; cannot promote`)
  }

  if (input.promotedBy === 'review') {
    if (!input.reviewId) throw new Error('Review-based promotion requires reviewId')
    const review = await store.getReview(input.tenantId, input.reviewId)
    if (!review) throw new Error(`Unknown review for promotion: ${input.reviewId}`)
    if (review.status !== 'approved') {
      throw new Error(`Review ${input.reviewId} is ${review.status}; promotion requires an approved review`)
    }
  }

  const now = Date.now()
  const trustState = input.trustState ?? 'user_confirmed'
  const fact: CanonicalFactRecord = {
    id: crypto.randomUUID(),
    tenant_id: input.tenantId,
    claim_id: claim.id,
    statement: claim.statement,
    trust_state: trustState,
    promoted_by: input.promotedBy,
    review_id: input.reviewId ?? null,
    superseded_by_id: null,
    created_at: now,
  }
  await store.insertFact(fact)
  await store.updateClaimTrust(input.tenantId, claim.id, trustState, 'can_use_as_instruction', now)
  await store.appendEvent({
    id: crypto.randomUUID(),
    tenant_id: input.tenantId,
    event_type: 'claim.promoted',
    subject_kind: 'claim',
    subject_id: claim.id,
    capture_id: claim.capture_id,
    actor_kind: input.promotedBy === 'user' ? 'user' : 'system',
    actor_identity: input.actorIdentity ?? null,
    occurred_at: now,
    recorded_at: now,
    detail_json: JSON.stringify({ factId: fact.id, promotedBy: input.promotedBy, trustState }),
  })
  return fact
}
