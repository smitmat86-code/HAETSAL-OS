import type { CompiledDocumentSourceInput } from './compiled-synthesis-schema'
import type {
  CompiledContradictionSectionRef,
  CompiledDecisionItem,
  CompiledFactSectionItem,
  CompiledOpenQuestionItem,
  CompiledRecommendedActionItem,
  CompiledRecentChangeItem,
  CompiledRelationshipSectionItem,
  CompiledSourceRefItem,
} from './compiled-synthesis-section-types'
import type {
  PersistCompiledArtifactInput,
  PersistCompiledContradictionInput,
  PersistCompiledEntityInput,
  PersistCompiledFactInput,
  PersistCompiledRelationshipInput,
  PersistCompiledSynthesisResult,
} from './compiled-synthesis-service-types'

export interface ProjectCompilationSubject {
  stableKey: string
  name: string
  scope: string
  keywords?: string[]
  /** Phase 10: person|project|topic pages ride the same compiler. */
  kind?: 'person' | 'project' | 'topic'
}

export interface CompileProjectSynthesisFromCanonicalTruthInput {
  tenantId: string
  subject: ProjectCompilationSubject
  tmk: CryptoKey
  sourceLimit?: number
}

export interface SelectedCanonicalCompilationSource {
  captureId: string
  documentId: string
  title: string | null
  sourceSystem: string
  sourceRef: string | null
  scope: string
  capturedAt: number
  body: string
  bodyR2Key: string
  artifactId: string | null
  artifactR2Key: string | null
  artifactMediaType: string | null
  score: number
}

export interface CanonicalCompilationSelection {
  tenantId: string
  subject: ProjectCompilationSubject
  documents: SelectedCanonicalCompilationSource[]
  sourceFingerprint: string
  artifactVersion: string
  sourceLinks: CompiledDocumentSourceInput[]
  sourceRefs: CompiledSourceRefItem[]
}

export interface AssembledProjectCompiledSynthesis {
  tenantId: string
  subject: ProjectCompilationSubject
  scope: string
  stableSegment: string
  sourceFingerprint: string
  artifactVersion: string
  sourceLinks: CompiledDocumentSourceInput[]
  sourceRefs: CompiledSourceRefItem[]
  entities: PersistCompiledEntityInput[]
  facts: PersistCompiledFactInput[]
  relationships: PersistCompiledRelationshipInput[]
  contradictions: PersistCompiledContradictionInput[]
  dossier: {
    stableKey: string
    title: string
    summary: string
    whyItMatters: string
    currentState: string
    keyFacts: CompiledFactSectionItem[]
    keyRelationships: CompiledRelationshipSectionItem[]
    recentUpdates: CompiledRecentChangeItem[]
    openQuestions: CompiledOpenQuestionItem[]
    contradictions: CompiledContradictionSectionRef[]
    recommendedActions: CompiledRecommendedActionItem[]
    recommendedReading: Array<{ title: string; note: string; artifactRole: string }>
  }
  contextPack: {
    stableKey: string
    title: string
    summary: string
    situation: string
    criticalFacts: CompiledFactSectionItem[]
    recentChanges: CompiledRecentChangeItem[]
    decisions: CompiledDecisionItem[]
    contradictions: CompiledContradictionSectionRef[]
    recommendedActions: CompiledRecommendedActionItem[]
  }
  whatChanged: {
    stableKey: string
    title: string
    summary: string
    changes: CompiledRecentChangeItem[]
    decisions: CompiledDecisionItem[]
    contradictions: CompiledContradictionSectionRef[]
    recommendedActions: CompiledRecommendedActionItem[]
  }
}

export interface RenderedProjectCompiledArtifacts {
  dossier: PersistCompiledArtifactInput[]
  contextPack: PersistCompiledArtifactInput[]
  whatChanged: PersistCompiledArtifactInput[]
}

export interface CompiledProjectSynthesisFamilyResult {
  stableKey: string
  result: PersistCompiledSynthesisResult
}

export interface CompileProjectSynthesisFromCanonicalTruthResult {
  sourceFingerprint: string
  sourceCount: number
  dossier: CompiledProjectSynthesisFamilyResult
  contextPack: CompiledProjectSynthesisFamilyResult
  whatChanged: CompiledProjectSynthesisFamilyResult
}
