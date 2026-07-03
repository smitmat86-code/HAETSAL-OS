import type { Env } from '../types/env'
import type { CanonicalTrustState, CanonicalUsePolicy } from '../types/canonical-governance'
import {
  getInstalledCanonicalGovernanceStore,
  installCanonicalGovernanceStore,
  type CanonicalClaimRecord,
  type CanonicalEdgeRecord,
  type CanonicalEdgeWithEntities,
  type CanonicalEntityRecord,
  type CanonicalEventRecord,
  type CanonicalFactRecord,
  type CanonicalGovernanceStore,
  type CanonicalRecallTraceRecord,
  type CanonicalReviewRecord,
} from './canonical-governance-store'

export class InMemoryCanonicalGovernanceStore implements CanonicalGovernanceStore {
  private readonly events: CanonicalEventRecord[] = []
  private readonly entities = new Map<string, CanonicalEntityRecord>()
  private readonly claims = new Map<string, CanonicalClaimRecord>()
  private readonly facts = new Map<string, CanonicalFactRecord>()
  private readonly edges = new Map<string, CanonicalEdgeRecord>()
  private readonly reviews = new Map<string, CanonicalReviewRecord>()
  private readonly recallTraces: CanonicalRecallTraceRecord[] = []

  async appendEvent(event: CanonicalEventRecord): Promise<void> {
    this.events.push({ ...event })
  }

  async listRecentEvents(tenantId: string, limit: number): Promise<CanonicalEventRecord[]> {
    return this.events
      .filter((event) => event.tenant_id === tenantId)
      .sort((left, right) => right.occurred_at - left.occurred_at || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((event) => ({ ...event }))
  }

  async upsertEntity(entity: CanonicalEntityRecord): Promise<CanonicalEntityRecord> {
    const existing = [...this.entities.values()].find((row) =>
      row.tenant_id === entity.tenant_id && row.kind === entity.kind && row.normalized_name === entity.normalized_name)
    if (!existing) {
      this.entities.set(entity.id, { ...entity })
      return { ...entity }
    }
    const merged: CanonicalEntityRecord = {
      ...existing,
      name: entity.name,
      aliases_json: entity.aliases_json ?? existing.aliases_json,
      last_seen_at: Math.max(existing.last_seen_at, entity.last_seen_at),
      updated_at: entity.updated_at,
    }
    this.entities.set(existing.id, merged)
    return { ...merged }
  }

  async getEntity(tenantId: string, entityId: string): Promise<CanonicalEntityRecord | null> {
    const row = this.entities.get(entityId)
    return row?.tenant_id === tenantId ? { ...row } : null
  }

  async findEntitiesByName(tenantId: string, name: string, limit: number): Promise<CanonicalEntityRecord[]> {
    const needle = name.trim().toLowerCase()
    return [...this.entities.values()]
      .filter((row) => row.tenant_id === tenantId
        && (row.normalized_name.includes(needle) || (row.aliases_json ?? '').toLowerCase().includes(needle)))
      .sort((left, right) => right.authority - left.authority || right.last_seen_at - left.last_seen_at)
      .slice(0, limit)
      .map((row) => ({ ...row }))
  }

  async listEdgesWithEntities(tenantId: string, limit: number): Promise<CanonicalEdgeWithEntities[]> {
    const rows: CanonicalEdgeWithEntities[] = []
    for (const edge of this.edges.values()) {
      if (edge.tenant_id !== tenantId) continue
      const src = this.entities.get(edge.src_entity_id)
      const dst = this.entities.get(edge.dst_entity_id)
      if (!src || !dst) continue
      rows.push({
        ...edge,
        src_kind: src.kind, src_name: src.name, src_normalized_name: src.normalized_name, src_aliases_json: src.aliases_json,
        dst_kind: dst.kind, dst_name: dst.name, dst_normalized_name: dst.normalized_name, dst_aliases_json: dst.aliases_json,
      })
    }
    return rows.sort((left, right) => right.updated_at - left.updated_at).slice(0, limit)
  }

  async insertClaim(claim: CanonicalClaimRecord): Promise<void> {
    this.claims.set(claim.id, { ...claim })
  }

  async getClaim(tenantId: string, claimId: string): Promise<CanonicalClaimRecord | null> {
    const row = this.claims.get(claimId)
    return row?.tenant_id === tenantId ? { ...row } : null
  }

  async updateClaimTrust(
    tenantId: string,
    claimId: string,
    trustState: CanonicalTrustState,
    usePolicy: CanonicalUsePolicy,
    updatedAt: number,
  ): Promise<void> {
    const row = this.claims.get(claimId)
    if (row?.tenant_id !== tenantId) return
    this.claims.set(claimId, { ...row, trust_state: trustState, use_policy: usePolicy, updated_at: updatedAt })
  }

  async insertFact(fact: CanonicalFactRecord): Promise<void> {
    this.facts.set(fact.id, { ...fact })
  }

  async getFact(tenantId: string, factId: string): Promise<CanonicalFactRecord | null> {
    const row = this.facts.get(factId)
    return row?.tenant_id === tenantId ? { ...row } : null
  }

  async upsertEdge(edge: CanonicalEdgeRecord): Promise<CanonicalEdgeRecord> {
    const existing = [...this.edges.values()].find((row) =>
      row.tenant_id === edge.tenant_id && row.src_entity_id === edge.src_entity_id
      && row.dst_entity_id === edge.dst_entity_id && row.edge_type === edge.edge_type)
    if (!existing) {
      this.edges.set(edge.id, { ...edge })
      return { ...edge }
    }
    const merged: CanonicalEdgeRecord = {
      ...existing,
      weight: edge.weight,
      confidence: edge.confidence ?? existing.confidence,
      capture_id: edge.capture_id ?? existing.capture_id,
      updated_at: edge.updated_at,
    }
    this.edges.set(existing.id, merged)
    return { ...merged }
  }

  async listEdgesForEntity(tenantId: string, entityId: string): Promise<CanonicalEdgeRecord[]> {
    return [...this.edges.values()]
      .filter((row) => row.tenant_id === tenantId
        && (row.src_entity_id === entityId || row.dst_entity_id === entityId))
      .sort((left, right) => right.updated_at - left.updated_at)
      .map((row) => ({ ...row }))
  }

  async createReview(review: CanonicalReviewRecord): Promise<void> {
    this.reviews.set(review.id, { ...review })
  }

  async getReview(tenantId: string, reviewId: string): Promise<CanonicalReviewRecord | null> {
    const row = this.reviews.get(reviewId)
    return row?.tenant_id === tenantId ? { ...row } : null
  }

  async decideReview(
    tenantId: string,
    reviewId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; decidedAt: number; note?: string | null },
  ): Promise<void> {
    const row = this.reviews.get(reviewId)
    if (row?.tenant_id !== tenantId || row.status !== 'pending') return
    this.reviews.set(reviewId, {
      ...row,
      status: decision.status,
      decided_at: decision.decidedAt,
      decided_by: decision.decidedBy,
      decision_note: decision.note ?? null,
    })
  }

  async listReviews(
    tenantId: string,
    status: CanonicalReviewRecord['status'] | null,
    limit: number,
  ): Promise<CanonicalReviewRecord[]> {
    return [...this.reviews.values()]
      .filter((row) => row.tenant_id === tenantId && (!status || row.status === status))
      .sort((left, right) => right.created_at - left.created_at)
      .slice(0, limit)
      .map((row) => ({ ...row }))
  }

  async insertRecallTrace(trace: CanonicalRecallTraceRecord): Promise<void> {
    this.recallTraces.push({ ...trace })
  }
}

export function installCanonicalGovernanceTestStore(env: Env): CanonicalGovernanceStore {
  const existing = getInstalledCanonicalGovernanceStore(env)
  if (existing) return existing
  return installCanonicalGovernanceStore(env, new InMemoryCanonicalGovernanceStore())
}
