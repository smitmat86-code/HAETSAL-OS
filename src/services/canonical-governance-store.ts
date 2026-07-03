import type { Env } from '../types/env'
import type {
  CanonicalClaimRecord,
  CanonicalEdgeRecord,
  CanonicalEntityRecord,
  CanonicalEventRecord,
  CanonicalFactRecord,
  CanonicalRecallTraceRecord,
  CanonicalReviewRecord,
} from '../types/canonical-governance-records'
import type { CanonicalTrustState, CanonicalUsePolicy } from '../types/canonical-governance'

export type {
  CanonicalClaimRecord,
  CanonicalEdgeRecord,
  CanonicalEntityRecord,
  CanonicalEventRecord,
  CanonicalFactRecord,
  CanonicalRecallTraceRecord,
  CanonicalReviewRecord,
} from '../types/canonical-governance-records'

export interface CanonicalGovernanceStore {
  appendEvent(event: CanonicalEventRecord): Promise<void>
  listRecentEvents(tenantId: string, limit: number): Promise<CanonicalEventRecord[]>
  upsertEntity(entity: CanonicalEntityRecord): Promise<CanonicalEntityRecord>
  getEntity(tenantId: string, entityId: string): Promise<CanonicalEntityRecord | null>
  insertClaim(claim: CanonicalClaimRecord): Promise<void>
  getClaim(tenantId: string, claimId: string): Promise<CanonicalClaimRecord | null>
  updateClaimTrust(
    tenantId: string,
    claimId: string,
    trustState: CanonicalTrustState,
    usePolicy: CanonicalUsePolicy,
    updatedAt: number,
  ): Promise<void>
  insertFact(fact: CanonicalFactRecord): Promise<void>
  getFact(tenantId: string, factId: string): Promise<CanonicalFactRecord | null>
  upsertEdge(edge: CanonicalEdgeRecord): Promise<CanonicalEdgeRecord>
  listEdgesForEntity(tenantId: string, entityId: string): Promise<CanonicalEdgeRecord[]>
  createReview(review: CanonicalReviewRecord): Promise<void>
  getReview(tenantId: string, reviewId: string): Promise<CanonicalReviewRecord | null>
  decideReview(
    tenantId: string,
    reviewId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; decidedAt: number; note?: string | null },
  ): Promise<void>
  listReviews(tenantId: string, status: CanonicalReviewRecord['status'] | null, limit: number): Promise<CanonicalReviewRecord[]>
  insertRecallTrace(trace: CanonicalRecallTraceRecord): Promise<void>
}

const GOVERNANCE_STORE = Symbol.for('haetsal.canonicalGovernanceStore')

type EnvWithStore = Env & { [GOVERNANCE_STORE]?: CanonicalGovernanceStore }

export function installCanonicalGovernanceStore(env: Env, store: CanonicalGovernanceStore): CanonicalGovernanceStore {
  Object.defineProperty(env, GOVERNANCE_STORE, {
    value: store,
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return store
}

export function getInstalledCanonicalGovernanceStore(env: Env): CanonicalGovernanceStore | null {
  return (env as EnvWithStore)[GOVERNANCE_STORE] ?? null
}
