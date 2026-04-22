import type {
  CompiledArtifactFormat,
  CompiledContradictionStatus,
  CompiledDocumentAudience,
  CompiledDocumentFamily,
} from './compiled-synthesis-records'

export interface CompiledDocumentUpsertInput {
  tenantId: string
  stableKey: string
  family: CompiledDocumentFamily
  scope: string
  title?: string | null
  summary?: string | null
  audience: CompiledDocumentAudience
  compiledAt: number
  updatedAt: number
}

export interface CompiledDocumentSourceInput {
  sourceRole: string
  canonicalCaptureId?: string | null
  canonicalDocumentId?: string | null
  canonicalArtifactId?: string | null
  canonicalOperationId?: string | null
}

export interface CompiledDocumentArtifactInput {
  compiledDocumentId: string
  artifactRole: string
  format: CompiledArtifactFormat
  version: string
  mediaType?: string | null
  r2Key: string
  sha256: string
  byteLength: number
  createdAt: number
}

export interface CompiledEntityUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  entityType: string
  name: string
  summary?: string | null
  compiledAt: number
  updatedAt: number
}

export interface CompiledFactUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  subjectEntityId?: string | null
  factType: string
  valueJson: string
  summary?: string | null
  compiledAt: number
  updatedAt: number
}

export interface CompiledRelationshipUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  subjectEntityId?: string | null
  objectEntityId?: string | null
  relationshipType: string
  summary?: string | null
  compiledAt: number
  updatedAt: number
}

export interface CompiledContradictionUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  leftFactId?: string | null
  rightFactId?: string | null
  title?: string | null
  summary: string
  status: CompiledContradictionStatus
  compiledAt: number
  updatedAt: number
}

export interface CompiledContextPackUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  packKind: string
  title: string
  summary?: string | null
  agentUsable: boolean
  humanUsable: boolean
  compiledAt: number
  updatedAt: number
}
