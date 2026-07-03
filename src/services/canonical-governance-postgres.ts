import type { Env } from '../types/env'
import type { CanonicalTrustState, CanonicalUsePolicy } from '../types/canonical-governance'
import { CANONICAL_BASE_DDL } from './canonical-postgres-base-ddl'
import { CANONICAL_GOVERNANCE_DDL } from './canonical-governance-ddl'
import { CANONICAL_POSTGRES_SCHEMA } from './canonical-postgres-schema'
import { createCanonicalPostgresSql, type PostgresSql } from './postgres-sql'
import {
  getInstalledCanonicalGovernanceStore,
  installCanonicalGovernanceStore,
  type CanonicalClaimRecord,
  type CanonicalEdgeRecord,
  type CanonicalEntityRecord,
  type CanonicalEventRecord,
  type CanonicalFactRecord,
  type CanonicalGovernanceStore,
  type CanonicalRecallTraceRecord,
  type CanonicalReviewRecord,
} from './canonical-governance-store'

const S = CANONICAL_POSTGRES_SCHEMA

export class PostgresCanonicalGovernanceStore implements CanonicalGovernanceStore {
  private schemaReadyPromise: Promise<void> | null = null

  constructor(private readonly sql: PostgresSql) {}

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = (async () => {
        await this.sql.query(`CREATE SCHEMA IF NOT EXISTS ${S}`)
        for (const statement of [...CANONICAL_BASE_DDL, ...CANONICAL_GOVERNANCE_DDL]) {
          await this.sql.query(statement)
        }
      })().catch((error) => {
        this.schemaReadyPromise = null
        throw error
      })
    }
    await this.schemaReadyPromise
  }

  private async rows<T>(query: Promise<unknown[]>): Promise<T[]> {
    await this.ensureSchema()
    return await query as T[]
  }

  async appendEvent(event: CanonicalEventRecord): Promise<void> {
    await this.rows(this.sql`INSERT INTO haetsal_canonical.canonical_events
      (id, tenant_id, event_type, subject_kind, subject_id, capture_id, actor_kind, actor_identity, occurred_at, recorded_at, detail_json)
      VALUES (${event.id}, ${event.tenant_id}, ${event.event_type}, ${event.subject_kind}, ${event.subject_id},
              ${event.capture_id}, ${event.actor_kind}, ${event.actor_identity}, ${event.occurred_at},
              ${event.recorded_at}, ${event.detail_json})`)
  }

  async listRecentEvents(tenantId: string, limit: number): Promise<CanonicalEventRecord[]> {
    return this.rows<CanonicalEventRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_events
      WHERE tenant_id = ${tenantId} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`)
  }

  async upsertEntity(entity: CanonicalEntityRecord): Promise<CanonicalEntityRecord> {
    const rows = await this.rows<CanonicalEntityRecord>(this.sql`INSERT INTO haetsal_canonical.canonical_entities
      (id, tenant_id, kind, name, normalized_name, aliases_json, authority, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (${entity.id}, ${entity.tenant_id}, ${entity.kind}, ${entity.name}, ${entity.normalized_name},
              ${entity.aliases_json}, ${entity.authority}, ${entity.first_seen_at}, ${entity.last_seen_at},
              ${entity.created_at}, ${entity.updated_at})
      ON CONFLICT (tenant_id, kind, normalized_name) DO UPDATE SET
        name = EXCLUDED.name,
        aliases_json = COALESCE(EXCLUDED.aliases_json, haetsal_canonical.canonical_entities.aliases_json),
        last_seen_at = GREATEST(haetsal_canonical.canonical_entities.last_seen_at, EXCLUDED.last_seen_at),
        updated_at = EXCLUDED.updated_at
      RETURNING *`)
    return rows[0]!
  }

  async getEntity(tenantId: string, entityId: string): Promise<CanonicalEntityRecord | null> {
    const rows = await this.rows<CanonicalEntityRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_entities
      WHERE tenant_id = ${tenantId} AND id = ${entityId} LIMIT 1`)
    return rows[0] ?? null
  }

  async insertClaim(claim: CanonicalClaimRecord): Promise<void> {
    await this.rows(this.sql`INSERT INTO haetsal_canonical.canonical_claims
      (id, tenant_id, capture_id, document_id, statement, subject_entity_id, object_entity_id, memory_class,
       trust_state, use_policy, confidence, author_kind, agent_identity, valid_from, valid_to, superseded_by_id,
       created_at, updated_at)
      VALUES (${claim.id}, ${claim.tenant_id}, ${claim.capture_id}, ${claim.document_id}, ${claim.statement},
              ${claim.subject_entity_id}, ${claim.object_entity_id}, ${claim.memory_class}, ${claim.trust_state},
              ${claim.use_policy}, ${claim.confidence}, ${claim.author_kind}, ${claim.agent_identity},
              ${claim.valid_from}, ${claim.valid_to}, ${claim.superseded_by_id}, ${claim.created_at}, ${claim.updated_at})`)
  }

  async getClaim(tenantId: string, claimId: string): Promise<CanonicalClaimRecord | null> {
    const rows = await this.rows<CanonicalClaimRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_claims
      WHERE tenant_id = ${tenantId} AND id = ${claimId} LIMIT 1`)
    return rows[0] ?? null
  }

  async updateClaimTrust(
    tenantId: string,
    claimId: string,
    trustState: CanonicalTrustState,
    usePolicy: CanonicalUsePolicy,
    updatedAt: number,
  ): Promise<void> {
    await this.rows(this.sql`UPDATE haetsal_canonical.canonical_claims
      SET trust_state = ${trustState}, use_policy = ${usePolicy}, updated_at = ${updatedAt}
      WHERE tenant_id = ${tenantId} AND id = ${claimId}`)
  }

  async insertFact(fact: CanonicalFactRecord): Promise<void> {
    await this.rows(this.sql`INSERT INTO haetsal_canonical.canonical_facts
      (id, tenant_id, claim_id, statement, trust_state, promoted_by, review_id, superseded_by_id, created_at)
      VALUES (${fact.id}, ${fact.tenant_id}, ${fact.claim_id}, ${fact.statement}, ${fact.trust_state},
              ${fact.promoted_by}, ${fact.review_id}, ${fact.superseded_by_id}, ${fact.created_at})`)
  }

  async getFact(tenantId: string, factId: string): Promise<CanonicalFactRecord | null> {
    const rows = await this.rows<CanonicalFactRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_facts
      WHERE tenant_id = ${tenantId} AND id = ${factId} LIMIT 1`)
    return rows[0] ?? null
  }

  async upsertEdge(edge: CanonicalEdgeRecord): Promise<CanonicalEdgeRecord> {
    const rows = await this.rows<CanonicalEdgeRecord>(this.sql`INSERT INTO haetsal_canonical.canonical_edges
      (id, tenant_id, src_entity_id, dst_entity_id, edge_type, weight, confidence, trust_state, capture_id,
       claim_id, valid_from, valid_to, created_at, updated_at)
      VALUES (${edge.id}, ${edge.tenant_id}, ${edge.src_entity_id}, ${edge.dst_entity_id}, ${edge.edge_type},
              ${edge.weight}, ${edge.confidence}, ${edge.trust_state}, ${edge.capture_id}, ${edge.claim_id},
              ${edge.valid_from}, ${edge.valid_to}, ${edge.created_at}, ${edge.updated_at})
      ON CONFLICT (tenant_id, src_entity_id, dst_entity_id, edge_type) DO UPDATE SET
        weight = EXCLUDED.weight,
        confidence = COALESCE(EXCLUDED.confidence, haetsal_canonical.canonical_edges.confidence),
        capture_id = COALESCE(EXCLUDED.capture_id, haetsal_canonical.canonical_edges.capture_id),
        updated_at = EXCLUDED.updated_at
      RETURNING *`)
    return rows[0]!
  }

  async listEdgesForEntity(tenantId: string, entityId: string): Promise<CanonicalEdgeRecord[]> {
    return this.rows<CanonicalEdgeRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_edges
      WHERE tenant_id = ${tenantId} AND (src_entity_id = ${entityId} OR dst_entity_id = ${entityId})
      ORDER BY updated_at DESC`)
  }

  async createReview(review: CanonicalReviewRecord): Promise<void> {
    await this.rows(this.sql`INSERT INTO haetsal_canonical.canonical_reviews
      (id, tenant_id, review_type, subject_kind, subject_id, proposal_json, status, created_at, decided_at, decided_by, decision_note)
      VALUES (${review.id}, ${review.tenant_id}, ${review.review_type}, ${review.subject_kind}, ${review.subject_id},
              ${review.proposal_json}, ${review.status}, ${review.created_at}, ${review.decided_at},
              ${review.decided_by}, ${review.decision_note})`)
  }

  async getReview(tenantId: string, reviewId: string): Promise<CanonicalReviewRecord | null> {
    const rows = await this.rows<CanonicalReviewRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_reviews
      WHERE tenant_id = ${tenantId} AND id = ${reviewId} LIMIT 1`)
    return rows[0] ?? null
  }

  async decideReview(
    tenantId: string,
    reviewId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; decidedAt: number; note?: string | null },
  ): Promise<void> {
    await this.rows(this.sql`UPDATE haetsal_canonical.canonical_reviews
      SET status = ${decision.status}, decided_at = ${decision.decidedAt}, decided_by = ${decision.decidedBy},
          decision_note = ${decision.note ?? null}
      WHERE tenant_id = ${tenantId} AND id = ${reviewId} AND status = 'pending'`)
  }

  async listReviews(
    tenantId: string,
    status: CanonicalReviewRecord['status'] | null,
    limit: number,
  ): Promise<CanonicalReviewRecord[]> {
    return this.rows<CanonicalReviewRecord>(this.sql`SELECT * FROM haetsal_canonical.canonical_reviews
      WHERE tenant_id = ${tenantId} AND (${status}::text IS NULL OR status = ${status})
      ORDER BY created_at DESC LIMIT ${limit}`)
  }

  async insertRecallTrace(trace: CanonicalRecallTraceRecord): Promise<void> {
    await this.rows(this.sql`INSERT INTO haetsal_canonical.canonical_recall_traces
      (id, tenant_id, query_mode, query_hash, request_json, result_refs_json, created_at)
      VALUES (${trace.id}, ${trace.tenant_id}, ${trace.query_mode}, ${trace.query_hash}, ${trace.request_json},
              ${trace.result_refs_json}, ${trace.created_at})`)
  }
}

export function getCanonicalGovernanceStore(env: Env): CanonicalGovernanceStore {
  const installed = getInstalledCanonicalGovernanceStore(env)
  if (installed) return installed
  return installCanonicalGovernanceStore(env, new PostgresCanonicalGovernanceStore(createCanonicalPostgresSql(env)))
}
