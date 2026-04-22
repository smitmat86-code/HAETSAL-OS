import type {
  CompiledArtifactFormat,
  CompiledDocumentAudience,
  CompiledDocumentFamily,
} from './compiled-synthesis-taxonomy'

export type * from './compiled-synthesis-output-records'
export type * from './compiled-synthesis-taxonomy'

export interface CompiledDocumentRecord {
  id: string
  tenant_id: string
  stable_key: string
  family: CompiledDocumentFamily
  scope: string
  title: string | null
  summary: string | null
  audience: CompiledDocumentAudience
  compiled_at: number
  created_at: number
  updated_at: number
}

export interface CompiledDocumentSourceRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  source_role: string
  canonical_capture_id: string | null
  canonical_document_id: string | null
  canonical_artifact_id: string | null
  canonical_operation_id: string | null
  created_at: number
}

export interface CompiledDocumentArtifactRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  artifact_role: string
  format: CompiledArtifactFormat
  version: string
  media_type: string | null
  r2_key: string
  sha256: string
  byte_length: number
  created_at: number
}

export interface CompiledEntityRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  entity_type: string
  name: string
  summary: string | null
  compiled_at: number
  created_at: number
  updated_at: number
}

export interface CompiledFactRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  subject_entity_id: string | null
  fact_type: string
  value_json: string
  summary: string | null
  compiled_at: number
  created_at: number
  updated_at: number
}

export interface CompiledRelationshipRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  subject_entity_id: string | null
  object_entity_id: string | null
  relationship_type: string
  summary: string | null
  compiled_at: number
  created_at: number
  updated_at: number
}
