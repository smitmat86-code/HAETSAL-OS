import type { CompiledArtifactFormat, CompiledChangeViewKind, CompiledContradictionFreshness, CompiledContradictionSeverity, CompiledContradictionStatus, CompiledDocumentAudience, CompiledDocumentFamily, CompiledDossierKind } from './compiled-synthesis-taxonomy'
import type { CompiledContradictionClaim, CompiledContradictionSectionRef, CompiledDecisionItem, CompiledFactSectionItem, CompiledOpenQuestionItem, CompiledRecommendedActionItem, CompiledRecommendedReadingItem, CompiledRecentChangeItem, CompiledRelationshipSectionItem, CompiledSourceRefItem } from './compiled-synthesis-section-types'

export interface PersistCompiledEntityInput { stableKey: string; scope: string; entityType: string; name: string; summary?: string | null }

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
  contradictionKind?: string
  conflictScope?: string | null
  severity?: CompiledContradictionSeverity
  freshness?: CompiledContradictionFreshness
  summary: string
  status: CompiledContradictionStatus
  leftClaim?: CompiledContradictionClaim
  rightClaim?: CompiledContradictionClaim
  suggestedResolution?: string | null
  resolutionSummary?: string | null
}

export interface PersistCompiledDossierInput {
  stableKey: string
  scope: string
  dossierKind: CompiledDossierKind
  subjectType: string
  subjectStableKey: string
  subjectName: string
  whyItMatters?: string | null
  currentState?: string | null
  keyFacts?: CompiledFactSectionItem[]
  keyRelationships?: CompiledRelationshipSectionItem[]
  recentUpdates?: CompiledRecentChangeItem[]
  openQuestions?: CompiledOpenQuestionItem[]
  contradictions?: CompiledContradictionSectionRef[]
  recommendedActions?: CompiledRecommendedActionItem[]
  recommendedNextReading?: CompiledRecommendedReadingItem[]
  sourceRefs?: CompiledSourceRefItem[]
}

export interface PersistCompiledContextPackInput {
  stableKey: string
  scope: string
  packKind: string
  title: string
  summary?: string | null
  agentUsable: boolean
  humanUsable: boolean
  situation?: string | null
  criticalFacts?: CompiledFactSectionItem[]
  recentChanges?: CompiledRecentChangeItem[]
  decisions?: CompiledDecisionItem[]
  contradictions?: CompiledContradictionSectionRef[]
  recommendedActions?: CompiledRecommendedActionItem[]
  sourceRefs?: CompiledSourceRefItem[]
}

export interface PersistCompiledChangeViewInput {
  stableKey: string
  scope: string
  viewKind: CompiledChangeViewKind
  title: string
  summary?: string | null
  decisions?: CompiledDecisionItem[]
  changes?: CompiledRecentChangeItem[]
  contradictions?: CompiledContradictionSectionRef[]
  recommendedActions?: CompiledRecommendedActionItem[]
  sourceRefs?: CompiledSourceRefItem[]
}

export interface PersistCompiledArtifactInput { artifactRole: string; format: CompiledArtifactFormat; version: string; mediaType?: string | null; contentEncrypted: string }

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
  dossier?: PersistCompiledDossierInput | null
  contextPack?: PersistCompiledContextPackInput | null
  changeView?: PersistCompiledChangeViewInput | null
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
  dossierId: string | null
  contextPackId: string | null
  changeViewId: string | null
}
