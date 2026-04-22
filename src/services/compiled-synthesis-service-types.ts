import type {
  CompiledArtifactFormat,
  CompiledContradictionStatus,
  CompiledDocumentAudience,
  CompiledDocumentFamily,
  CompiledSynthesisBundle,
} from './compiled-synthesis-schema'

export interface PersistCompiledEntityInput {
  stableKey: string
  scope: string
  entityType: string
  name: string
  summary?: string | null
}

export interface PersistCompiledFactInput {
  stableKey: string
  scope: string
  subjectEntityStableKey?: string | null
  factType: string
  value: unknown
  summary?: string | null
}

export interface PersistCompiledRelationshipInput {
  stableKey: string
  scope: string
  subjectEntityStableKey?: string | null
  objectEntityStableKey?: string | null
  relationshipType: string
  summary?: string | null
}

export interface PersistCompiledContradictionInput {
  stableKey: string
  scope: string
  leftFactStableKey?: string | null
  rightFactStableKey?: string | null
  title?: string | null
  summary: string
  status: CompiledContradictionStatus
}

export interface PersistCompiledContextPackInput {
  stableKey: string
  scope: string
  packKind: string
  title: string
  summary?: string | null
  agentUsable: boolean
  humanUsable: boolean
}

export interface PersistCompiledArtifactInput {
  artifactRole: string
  format: CompiledArtifactFormat
  version: string
  mediaType?: string | null
  contentEncrypted: string
}

export interface PersistCompiledSynthesisInput {
  tenantId: string
  document: {
    stableKey: string
    family: CompiledDocumentFamily
    scope: string
    title?: string | null
    summary?: string | null
    audience: CompiledDocumentAudience
  }
  sources: import('./compiled-synthesis-schema').CompiledDocumentSourceInput[]
  entities?: PersistCompiledEntityInput[]
  facts?: PersistCompiledFactInput[]
  relationships?: PersistCompiledRelationshipInput[]
  contradictions?: PersistCompiledContradictionInput[]
  contextPack?: PersistCompiledContextPackInput | null
  artifacts?: PersistCompiledArtifactInput[]
  compiledAt?: number
}

export interface PersistCompiledSynthesisResult {
  documentId: string
  documentStableKey: string
  artifactRefs: Array<{ artifactId: string; artifactRole: string; version: string; r2Key: string }>
  entityIds: string[]
  factIds: string[]
  relationshipIds: string[]
  contradictionIds: string[]
  contextPackId: string | null
}

export type { CompiledSynthesisBundle }
