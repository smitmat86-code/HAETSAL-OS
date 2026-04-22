import type {
  CompiledContradictionSeverity,
  CompiledContradictionStatus,
} from './compiled-synthesis-taxonomy'

export interface CompiledFactSectionItem {
  label: string
  summary: string
  factStableKey?: string | null
  subjectStableKey?: string | null
}

export interface CompiledRelationshipSectionItem {
  label: string
  summary: string
  relationshipStableKey?: string | null
  counterpartStableKey?: string | null
}

export interface CompiledRecentChangeItem {
  summary: string
  changeKind?: string | null
  changedAt?: number | null
}

export interface CompiledOpenQuestionItem {
  question: string
  status?: 'open' | 'watch' | 'answered'
  owner?: string | null
}

export interface CompiledRecommendedActionItem {
  summary: string
  status?: 'pending' | 'suggested' | 'done'
  owner?: string | null
  dueAt?: number | null
}

export interface CompiledRecommendedReadingItem {
  title: string
  note?: string | null
  artifactRole?: string | null
  r2Key?: string | null
}

export interface CompiledDecisionItem {
  summary: string
  decisionStableKey?: string | null
  status?: 'active' | 'tentative' | 'superseded'
  decidedAt?: number | null
}

export interface CompiledSourceRefItem {
  label?: string | null
  sourceRole?: string | null
  canonicalCaptureId?: string | null
  canonicalDocumentId?: string | null
  canonicalArtifactId?: string | null
  canonicalOperationId?: string | null
  r2Key?: string | null
}

export interface CompiledContradictionClaim {
  summary: string
  factStableKey?: string | null
  sourceRole?: string | null
}

export interface CompiledContradictionSectionRef {
  contradictionStableKey: string
  summary: string
  status: CompiledContradictionStatus
  severity?: CompiledContradictionSeverity | null
}
