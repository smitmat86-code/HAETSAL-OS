import type { CanonicalGraphIdentityMapping } from '../types/canonical-graph-projection'
import type {
  CanonicalAuthorKind,
  CanonicalMemoryClass,
  CanonicalRetention,
  CanonicalTrustState,
  CanonicalUsePolicy,
} from '../types/canonical-governance'
import type { CanonicalEventRecord } from '../types/canonical-governance-records'

export const CANONICAL_POSTGRES_SCHEMA = 'haetsal_canonical'

/**
 * 'hindsight' remains in the union so historical projection rows stay
 * readable; new hindsight projections are rejected (write path severed,
 * HAETSAL_MISSION.md Phase 1).
 */
export type CanonicalProjectionKind = 'hindsight' | 'graphiti'
export type CanonicalProjectionStatus = 'accepted' | 'queued' | 'completed' | 'failed'

export interface CanonicalCaptureRecord {
  id: string
  tenant_id: string
  source_system: string
  source_ref: string | null
  scope: string
  title: string | null
  body_r2_key: string
  body_sha256: string
  artifact_id: string | null
  captured_at: number
  created_at: number
  memory_class: CanonicalMemoryClass
  trust_state: CanonicalTrustState
  use_policy: CanonicalUsePolicy
  author_kind: CanonicalAuthorKind
  agent_identity: string | null
  model_runtime: string | null
  confidence: number | null
  retention: CanonicalRetention
  provenance_note: string | null
  memory_type: string | null
  dedup_hash: string | null
  salience_tier: number | null
  governance_downgraded_json: string | null
}

export interface CanonicalArtifactRecord {
  id: string
  tenant_id: string
  capture_id: string
  storage_kind: string
  r2_key: string | null
  media_type: string | null
  filename: string | null
  byte_length: number | null
  sha256: string | null
  created_at: number
}

export interface CanonicalDocumentRecord {
  id: string
  tenant_id: string
  capture_id: string
  artifact_id: string | null
  title: string | null
  body_r2_key: string
  body_sha256: string
  chunk_count: number
  created_at: number
}

export interface CanonicalChunkRecord {
  id: string
  tenant_id: string
  document_id: string
  ordinal: number
  start_offset: number
  end_offset: number
  chunk_sha256: string
  /** Plaintext chunk body for Postgres FTS — authorized Law 2 boundary (Phase 1). */
  chunk_text: string | null
  created_at: number
}

export interface CanonicalMemoryOperationRecord {
  id: string
  tenant_id: string
  capture_id: string
  operation_type: string
  status: CanonicalProjectionStatus
  created_at: number
  updated_at: number
}

export interface CanonicalProjectionJobRecord {
  id: string
  tenant_id: string
  operation_id: string
  capture_id: string
  document_id: string
  projection_kind: CanonicalProjectionKind
  status: CanonicalProjectionStatus
  created_at: number
  enqueued_at: number
}

export interface CanonicalProjectionResultRecord {
  id: string
  tenant_id: string
  projection_job_id: string
  status: CanonicalProjectionStatus
  target_ref: string | null
  error_message: string | null
  engine_bank_id: string | null
  engine_document_id: string | null
  engine_operation_id: string | null
  created_at: number
  updated_at: number
}

export interface CanonicalGraphIdentityMappingRecord {
  id: string
  tenant_id: string
  projection_job_id: string
  canonical_key: string
  graph_ref: string
  graph_kind: string
  created_at: number
  updated_at: number
}

export interface CanonicalCaptureWrite {
  capture: CanonicalCaptureRecord
  artifact: CanonicalArtifactRecord | null
  document: CanonicalDocumentRecord
  chunks: CanonicalChunkRecord[]
  operation: CanonicalMemoryOperationRecord
  projectionJobs: CanonicalProjectionJobRecord[]
  /** Append-only ledger entry recorded atomically with the capture. */
  event: CanonicalEventRecord | null
}

export interface CanonicalListRow {
  capture_id: string
  document_id: string
  title: string | null
  scope: string
  source_system: string
  source_ref: string | null
  captured_at: number
  body_r2_key: string
}

export interface CanonicalDocumentLookupRow extends CanonicalListRow {
  document_created_at: number
  chunk_count: number
  artifact_id: string | null
  filename: string | null
  media_type: string | null
  byte_length: number | null
  storage_kind: string | null
  r2_key: string | null
}

export interface CanonicalOperationLookupRow {
  id: string
  capture_id: string
  operation_type: string
  status: CanonicalProjectionStatus
  created_at: number
  updated_at: number
  source_system: string
  source_ref: string | null
  scope: string
  title: string | null
  captured_at: number
}

export interface CanonicalProjectionJobSummary {
  id: string
  projection_kind: CanonicalProjectionKind
}

export interface CanonicalProjectionStateRow {
  projection_result_id: string | null
  job_id: string
  document_id: string
  projection_kind: CanonicalProjectionKind
  status: CanonicalProjectionStatus
  result_status: CanonicalProjectionStatus | null
  target_ref: string | null
  error_message: string | null
  engine_document_id: string | null
  engine_operation_id: string | null
  engine_bank_id: string | null
  result_updated_at: number | null
}

export interface CanonicalProjectionJobContextRow {
  id: string
  operation_id: string
  capture_id: string
  document_id: string
  projection_kind: CanonicalProjectionKind
  source_system: string
  source_ref: string | null
  scope: string
  title: string | null
  captured_at: number
  body_r2_key: string
  artifact_filename: string | null
  artifact_media_type: string | null
  artifact_storage_key: string | null
}

export interface CanonicalDispatchStateInput {
  tenantId: string
  operationId: string
  status: 'queued' | 'failed'
  updatedAt: number
  errorMessage?: string | null
}

export interface CanonicalProjectionStateWriteInput {
  tenantId: string
  jobId: string
  operationId: string
  jobStatus: CanonicalProjectionStatus
  resultStatus: CanonicalProjectionStatus
  targetRef: string | null
  errorMessage?: string | null
  engineBankId?: string | null
  engineDocumentId?: string | null
  engineOperationId?: string | null
  updatedAt: number
  graphMappings?: CanonicalGraphIdentityMapping[]
}

export interface CanonicalHindsightProjectionLookupRow {
  capture_id: string
  document_id: string
  operation_id: string
  projection_job_id: string
  projection_result_id: string
  projection_status: CanonicalProjectionStatus
  result_status: CanonicalProjectionStatus
  engine_document_id: string | null
  engine_operation_id: string | null
  target_ref: string | null
}

export interface CanonicalSemanticLinkbackRow {
  capture_id: string
  document_id: string
  operation_id: string
  projection_job_id: string
  projection_result_id: string
  scope: string
  source_system: string
  source_ref: string | null
  title: string | null
  captured_at: number
  projection_status: CanonicalProjectionStatus
  result_status: CanonicalProjectionStatus
  target_ref: string | null
  engine_document_id: string | null
  engine_operation_id: string | null
}

export interface CanonicalGraphEdgeObservationRow {
  canonical_key: string
  graph_ref: string
  projection_job_id: string
  projection_result_id: string | null
  target_ref: string | null
  operation_id: string
  capture_id: string
  document_id: string
  scope: string
  source_system: string
  source_ref: string | null
  title: string | null
  captured_at: number | null
}

export interface CanonicalStatsRow {
  captureCount: number
  documentCount: number
  chunkCount: number
  operationCount: number
  pendingProjectionCount: number
  completedProjectionCount: number
  failedProjectionCount: number
  lastCaptureAt: number | null
  scopes: Array<{ scope: string; count: number }>
}
