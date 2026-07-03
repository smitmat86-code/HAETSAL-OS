// Mission Phase 1: governance primitive store contracts —
// entities, claims, facts, edges, reviews, promotion discipline.

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { installCanonicalGovernanceTestStore } from '../src/services/canonical-governance-memory'
import { promoteClaim } from '../src/services/canonical-promotion'
import type {
  CanonicalClaimRecord,
  CanonicalEdgeRecord,
  CanonicalEntityRecord,
  CanonicalReviewRecord,
} from '../src/types/canonical-governance-records'

const TENANT_ID = `test-tenant-mission-11-${crypto.randomUUID()}`
const store = installCanonicalGovernanceTestStore(env)

function makeEntity(name: string, overrides?: Partial<CanonicalEntityRecord>): CanonicalEntityRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT_ID,
    kind: 'person',
    name,
    normalized_name: name.toLowerCase(),
    aliases_json: null,
    authority: 0,
    first_seen_at: now,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeClaim(statement: string, overrides?: Partial<CanonicalClaimRecord>): CanonicalClaimRecord {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT_ID,
    capture_id: null,
    document_id: null,
    statement,
    subject_entity_id: null,
    object_entity_id: null,
    memory_class: 'claim',
    trust_state: 'evidence',
    use_policy: 'can_use_as_evidence',
    confidence: 0.7,
    author_kind: 'agent',
    agent_identity: 'chief_of_staff',
    valid_from: null,
    valid_to: null,
    superseded_by_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeReview(subjectId: string, overrides?: Partial<CanonicalReviewRecord>): CanonicalReviewRecord {
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT_ID,
    review_type: 'promotion',
    subject_kind: 'claim',
    subject_id: subjectId,
    proposal_json: JSON.stringify({ promoteTo: 'fact' }),
    status: 'pending',
    created_at: Date.now(),
    decided_at: null,
    decided_by: null,
    decision_note: null,
    ...overrides,
  }
}

describe('mission 1.1 — entity and edge primitives', () => {
  it('upserts entities by (tenant, kind, normalized_name) and merges recency', async () => {
    const first = await store.upsertEntity(makeEntity('Alice Chen'))
    const second = await store.upsertEntity(makeEntity('Alice Chen', {
      last_seen_at: first.last_seen_at + 5000,
      updated_at: first.updated_at + 5000,
    }))

    expect(second.id).toBe(first.id)
    expect(second.last_seen_at).toBe(first.last_seen_at + 5000)
  })

  it('upserts edges by (tenant, src, dst, type) preserving provenance', async () => {
    const alice = await store.upsertEntity(makeEntity('Alice Edge'))
    const atlas = await store.upsertEntity(makeEntity('Project Atlas', { kind: 'project' }))
    const now = Date.now()
    const edge: CanonicalEdgeRecord = {
      id: crypto.randomUUID(),
      tenant_id: TENANT_ID,
      src_entity_id: alice.id,
      dst_entity_id: atlas.id,
      edge_type: 'works_on',
      weight: 1,
      confidence: 0.6,
      trust_state: 'evidence',
      capture_id: 'capture-1',
      claim_id: null,
      valid_from: null,
      valid_to: null,
      created_at: now,
      updated_at: now,
    }
    const created = await store.upsertEdge(edge)
    const updated = await store.upsertEdge({ ...edge, id: crypto.randomUUID(), weight: 2, capture_id: null, updated_at: now + 1000 })
    const edges = await store.listEdgesForEntity(TENANT_ID, alice.id)

    expect(updated.id).toBe(created.id)
    expect(updated.weight).toBe(2)
    expect(updated.capture_id).toBe('capture-1')
    expect(edges).toHaveLength(1)
  })
})

describe('mission 1.1 — promotion requires policy or review', () => {
  it('promotes a claim to a fact through an approved review', async () => {
    const claim = makeClaim('Alice leads Atlas')
    await store.insertClaim(claim)
    const review = makeReview(claim.id)
    await store.createReview(review)
    await store.decideReview(TENANT_ID, review.id, { status: 'approved', decidedBy: 'matt', decidedAt: Date.now() })

    const fact = await promoteClaim({
      tenantId: TENANT_ID,
      claimId: claim.id,
      promotedBy: 'review',
      reviewId: review.id,
    }, env)

    const promoted = await store.getClaim(TENANT_ID, claim.id)
    const events = await store.listRecentEvents(TENANT_ID, 10)
    expect(fact.statement).toBe('Alice leads Atlas')
    expect(fact.trust_state).toBe('user_confirmed')
    expect(promoted?.trust_state).toBe('user_confirmed')
    expect(promoted?.use_policy).toBe('can_use_as_instruction')
    expect(events.some((event) => event.event_type === 'claim.promoted' && event.subject_id === claim.id)).toBe(true)
  })

  it('refuses review-based promotion without an approved review', async () => {
    const claim = makeClaim('Bob owns billing')
    await store.insertClaim(claim)
    const pending = makeReview(claim.id)
    await store.createReview(pending)

    await expect(promoteClaim({
      tenantId: TENANT_ID, claimId: claim.id, promotedBy: 'review', reviewId: pending.id,
    }, env)).rejects.toThrow(/pending/)

    const rejected = makeReview(claim.id)
    await store.createReview(rejected)
    await store.decideReview(TENANT_ID, rejected.id, { status: 'rejected', decidedBy: 'matt', decidedAt: Date.now() })
    await expect(promoteClaim({
      tenantId: TENANT_ID, claimId: claim.id, promotedBy: 'review', reviewId: rejected.id,
    }, env)).rejects.toThrow(/rejected/)

    await expect(promoteClaim({
      tenantId: TENANT_ID, claimId: claim.id, promotedBy: 'review',
    }, env)).rejects.toThrow(/reviewId/)
  })

  it('refuses to promote rejected or superseded claims', async () => {
    const claim = makeClaim('Stale claim', { trust_state: 'superseded' })
    await store.insertClaim(claim)
    await expect(promoteClaim({
      tenantId: TENANT_ID, claimId: claim.id, promotedBy: 'user',
    }, env)).rejects.toThrow(/superseded/)
  })

  it('review decisions are single-shot (pending only)', async () => {
    const claim = makeClaim('One-shot decision')
    await store.insertClaim(claim)
    const review = makeReview(claim.id)
    await store.createReview(review)
    await store.decideReview(TENANT_ID, review.id, { status: 'rejected', decidedBy: 'matt', decidedAt: Date.now() })
    await store.decideReview(TENANT_ID, review.id, { status: 'approved', decidedBy: 'matt', decidedAt: Date.now() })

    const final = await store.getReview(TENANT_ID, review.id)
    expect(final?.status).toBe('rejected')
  })
})
