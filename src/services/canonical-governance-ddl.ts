import { CANONICAL_POSTGRES_SCHEMA } from './canonical-postgres-schema'

const S = CANONICAL_POSTGRES_SCHEMA

/**
 * Phase 1 governed-write-path schema (HAETSAL_MISSION.md §8 Phase 1).
 * Idempotent: CREATE/ALTER IF NOT EXISTS only. Applied by the canonical
 * Postgres store's ensureSchema alongside the base canonical DDL.
 *
 * Law 2 note: canonical Postgres via Hyperdrive is the authorized plaintext
 * boundary for memory content (shifted from the Hindsight container).
 * chunk_text / claim statements / message content are plaintext here by
 * design; encrypted archival bodies remain in R2.
 */
export const CANONICAL_GOVERNANCE_DDL: string[] = [
  // Provenance envelope + governance columns on captures
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS memory_class TEXT NOT NULL DEFAULT 'raw_source'`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS trust_state TEXT NOT NULL DEFAULT 'evidence'`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS use_policy TEXT NOT NULL DEFAULT 'can_use_as_evidence'`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS author_kind TEXT NOT NULL DEFAULT 'system'`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS agent_identity TEXT`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS model_runtime TEXT`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS retention TEXT NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS provenance_note TEXT`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS memory_type TEXT`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS dedup_hash TEXT`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS salience_tier INTEGER`,
  `ALTER TABLE ${S}.canonical_captures ADD COLUMN IF NOT EXISTS governance_downgraded_json TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_captures_tenant_class
    ON ${S}.canonical_captures(tenant_id, memory_class, trust_state, created_at DESC)`,
  // Searchable plaintext for Phase 2 FTS (authorized boundary)
  `ALTER TABLE ${S}.canonical_chunks ADD COLUMN IF NOT EXISTS chunk_text TEXT`,
  // Append-only event ledger
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    capture_id TEXT,
    actor_kind TEXT NOT NULL,
    actor_identity TEXT,
    occurred_at BIGINT NOT NULL,
    recorded_at BIGINT NOT NULL,
    detail_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_events_tenant_time
    ON ${S}.canonical_events(tenant_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_events_tenant_type
    ON ${S}.canonical_events(tenant_id, event_type, occurred_at DESC)`,
  // Working sessions become evidence (wired in Phase 9)
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    external_ref TEXT,
    started_at BIGINT NOT NULL,
    closed_at BIGINT,
    summary_capture_id TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_sessions_tenant
    ON ${S}.canonical_sessions(tenant_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_messages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES ${S}.canonical_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    occurred_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_messages_session
    ON ${S}.canonical_messages(tenant_id, session_id, occurred_at)`,
  // Entities + typed edges (Postgres-native graph; the only graph path post-Graphiti)
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_entities (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    aliases_json TEXT,
    authority DOUBLE PRECISION NOT NULL DEFAULT 0,
    first_seen_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_entities_identity
    ON ${S}.canonical_entities(tenant_id, kind, normalized_name)`,
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_claims (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    capture_id TEXT,
    document_id TEXT,
    statement TEXT NOT NULL,
    subject_entity_id TEXT,
    object_entity_id TEXT,
    memory_class TEXT NOT NULL DEFAULT 'claim',
    trust_state TEXT NOT NULL DEFAULT 'evidence',
    use_policy TEXT NOT NULL DEFAULT 'can_use_as_evidence',
    confidence DOUBLE PRECISION,
    author_kind TEXT NOT NULL DEFAULT 'system',
    agent_identity TEXT,
    valid_from BIGINT,
    valid_to BIGINT,
    superseded_by_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_claims_tenant_trust
    ON ${S}.canonical_claims(tenant_id, trust_state, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_claims_subject
    ON ${S}.canonical_claims(tenant_id, subject_entity_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_facts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    claim_id TEXT NOT NULL REFERENCES ${S}.canonical_claims(id) ON DELETE CASCADE,
    statement TEXT NOT NULL,
    trust_state TEXT NOT NULL,
    promoted_by TEXT NOT NULL,
    review_id TEXT,
    superseded_by_id TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_facts_tenant
    ON ${S}.canonical_facts(tenant_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_edges (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    src_entity_id TEXT NOT NULL REFERENCES ${S}.canonical_entities(id) ON DELETE CASCADE,
    dst_entity_id TEXT NOT NULL REFERENCES ${S}.canonical_entities(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1,
    confidence DOUBLE PRECISION,
    trust_state TEXT NOT NULL DEFAULT 'evidence',
    capture_id TEXT,
    claim_id TEXT,
    valid_from BIGINT,
    valid_to BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_edges_identity
    ON ${S}.canonical_edges(tenant_id, src_entity_id, dst_entity_id, edge_type)`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_edges_src
    ON ${S}.canonical_edges(tenant_id, src_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_edges_dst
    ON ${S}.canonical_edges(tenant_id, dst_entity_id)`,
  // Review inbox (promotion / contradiction / supersession proposals)
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_reviews (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    review_type TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    decided_at BIGINT,
    decided_by TEXT,
    decision_note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_reviews_tenant_status
    ON ${S}.canonical_reviews(tenant_id, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_policies (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    policy_kind TEXT NOT NULL,
    name TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_policies_name
    ON ${S}.canonical_policies(tenant_id, policy_kind, name)`,
  // Retrieval traces (populated by the Phase 2 broker)
  `CREATE TABLE IF NOT EXISTS ${S}.canonical_recall_traces (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    query_mode TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    request_json TEXT,
    result_refs_json TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pg_canonical_recall_traces_tenant
    ON ${S}.canonical_recall_traces(tenant_id, created_at DESC)`,
]
