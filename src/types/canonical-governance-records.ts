import type {
  CanonicalAuthorKind,
  CanonicalMemoryClass,
  CanonicalTrustState,
  CanonicalUsePolicy,
} from './canonical-governance'

export interface CanonicalEventRecord {
  id: string
  tenant_id: string
  event_type: string
  subject_kind: string
  subject_id: string
  capture_id: string | null
  actor_kind: string
  actor_identity: string | null
  occurred_at: number
  recorded_at: number
  detail_json: string | null
}

export interface CanonicalEntityRecord {
  id: string
  tenant_id: string
  kind: string
  name: string
  normalized_name: string
  aliases_json: string | null
  authority: number
  first_seen_at: number
  last_seen_at: number
  created_at: number
  updated_at: number
}

export interface CanonicalClaimRecord {
  id: string
  tenant_id: string
  capture_id: string | null
  document_id: string | null
  statement: string
  subject_entity_id: string | null
  object_entity_id: string | null
  memory_class: CanonicalMemoryClass
  trust_state: CanonicalTrustState
  use_policy: CanonicalUsePolicy
  confidence: number | null
  author_kind: CanonicalAuthorKind
  agent_identity: string | null
  valid_from: number | null
  valid_to: number | null
  superseded_by_id: string | null
  created_at: number
  updated_at: number
}

export interface CanonicalFactRecord {
  id: string
  tenant_id: string
  claim_id: string
  statement: string
  trust_state: CanonicalTrustState
  promoted_by: 'policy' | 'review' | 'user'
  review_id: string | null
  superseded_by_id: string | null
  created_at: number
}

export interface CanonicalEdgeRecord {
  id: string
  tenant_id: string
  src_entity_id: string
  dst_entity_id: string
  edge_type: string
  weight: number
  confidence: number | null
  trust_state: CanonicalTrustState
  capture_id: string | null
  claim_id: string | null
  valid_from: number | null
  valid_to: number | null
  created_at: number
  updated_at: number
}

export interface CanonicalReviewRecord {
  id: string
  tenant_id: string
  review_type: string
  subject_kind: string
  subject_id: string
  proposal_json: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: number
  decided_at: number | null
  decided_by: string | null
  decision_note: string | null
}

export interface CanonicalRecallTraceRecord {
  id: string
  tenant_id: string
  query_mode: string
  query_hash: string
  request_json: string | null
  result_refs_json: string | null
  created_at: number
}
