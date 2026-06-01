import type {
  CompiledChangeViewRecord,
  CompiledContextPackRecord,
  CompiledContradictionFreshness,
  CompiledContradictionRecord,
  CompiledContradictionSeverity,
  CompiledContradictionStatus,
  CompiledDocumentArtifactRecord,
  CompiledDocumentRecord,
  CompiledDocumentSourceRecord,
  CompiledDossierKind,
  CompiledDossierRecord,
  CompiledEntityRecord,
  CompiledFactRecord,
  CompiledRelationshipRecord,
} from './compiled-synthesis-records'
import type {
  CompiledContradictionClaim,
  CompiledContradictionSectionRef,
  CompiledDecisionItem,
  CompiledFactSectionItem,
  CompiledOpenQuestionItem,
  CompiledRecommendedActionItem,
  CompiledRecommendedReadingItem,
  CompiledRecentChangeItem,
  CompiledRelationshipSectionItem,
  CompiledSourceRefItem,
} from './compiled-synthesis-section-types'

export interface CompiledDossierView {
  record: CompiledDossierRecord
  dossierKind: CompiledDossierKind
  subjectType: string
  subjectStableKey: string
  subjectName: string
  whyItMatters: string | null
  currentState: string | null
  keyFacts: CompiledFactSectionItem[]
  keyRelationships: CompiledRelationshipSectionItem[]
  recentUpdates: CompiledRecentChangeItem[]
  openQuestions: CompiledOpenQuestionItem[]
  contradictions: CompiledContradictionSectionRef[]
  recommendedActions: CompiledRecommendedActionItem[]
  recommendedNextReading: CompiledRecommendedReadingItem[]
  sourceRefs: CompiledSourceRefItem[]
}

export interface CompiledContextPackView {
  record: CompiledContextPackRecord
  packKind: string
  title: string
  summary: string | null
  agentUsable: boolean
  humanUsable: boolean
  situation: string | null
  criticalFacts: CompiledFactSectionItem[]
  recentChanges: CompiledRecentChangeItem[]
  decisions: CompiledDecisionItem[]
  contradictions: CompiledContradictionSectionRef[]
  recommendedActions: CompiledRecommendedActionItem[]
  sourceRefs: CompiledSourceRefItem[]
}

export interface CompiledChangeView {
  record: CompiledChangeViewRecord
  viewKind: 'decision_log' | 'what_changed'
  title: string
  summary: string | null
  decisions: CompiledDecisionItem[]
  changes: CompiledRecentChangeItem[]
  contradictions: CompiledContradictionSectionRef[]
  recommendedActions: CompiledRecommendedActionItem[]
  sourceRefs: CompiledSourceRefItem[]
}

export interface CompiledContradictionView {
  record: CompiledContradictionRecord
  stableKey: string
  scope: string
  title: string | null
  contradictionKind: string
  conflictScope: string | null
  severity: CompiledContradictionSeverity
  freshness: CompiledContradictionFreshness
  summary: string
  status: CompiledContradictionStatus
  leftFactId: string | null
  rightFactId: string | null
  leftClaim: CompiledContradictionClaim
  rightClaim: CompiledContradictionClaim
  suggestedResolution: string | null
  resolutionSummary: string | null
}

export interface CompiledSynthesisView {
  document: CompiledDocumentRecord
  sources: CompiledDocumentSourceRecord[]
  artifacts: CompiledDocumentArtifactRecord[]
  entities: CompiledEntityRecord[]
  facts: CompiledFactRecord[]
  relationships: CompiledRelationshipRecord[]
  contradictions: CompiledContradictionView[]
  dossier: CompiledDossierView | null
  contextPack: CompiledContextPackView | null
  changeView: CompiledChangeView | null
}

export interface CompiledDossierReadModel extends CompiledSynthesisView {
  dossier: CompiledDossierView
}

export interface CompiledContextPackReadModel extends CompiledSynthesisView {
  contextPack: CompiledContextPackView
}

export interface CompiledChangeViewReadModel extends CompiledSynthesisView {
  changeView: CompiledChangeView
}
