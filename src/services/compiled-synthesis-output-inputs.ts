import type {
  CompiledChangeViewKind,
  CompiledContradictionFreshness,
  CompiledContradictionSeverity,
  CompiledContradictionStatus,
  CompiledDossierKind,
} from './compiled-synthesis-taxonomy'

export interface CompiledContradictionUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  leftFactId?: string | null
  rightFactId?: string | null
  title?: string | null
  contradictionKind: string
  conflictScope?: string | null
  severity: CompiledContradictionSeverity
  freshness: CompiledContradictionFreshness
  summary: string
  status: CompiledContradictionStatus
  leftClaimJson: string
  rightClaimJson: string
  suggestedResolution?: string | null
  resolutionSummary?: string | null
  compiledAt: number
  updatedAt: number
}

export interface CompiledDossierUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  dossierKind: CompiledDossierKind
  subjectType: string
  subjectStableKey: string
  subjectName: string
  whyItMatters?: string | null
  currentState?: string | null
  keyFactsJson: string
  keyRelationshipsJson: string
  recentUpdatesJson: string
  openQuestionsJson: string
  contradictionRefsJson: string
  recommendedActionsJson: string
  recommendedReadingJson: string
  sourceRefsJson: string
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
  situation?: string | null
  criticalFactsJson: string
  recentChangesJson: string
  decisionsJson: string
  contradictionsJson: string
  recommendedActionsJson: string
  sourceRefsJson: string
  compiledAt: number
  updatedAt: number
}

export interface CompiledChangeViewUpsertInput {
  tenantId: string
  compiledDocumentId: string
  stableKey: string
  scope: string
  viewKind: CompiledChangeViewKind
  title: string
  summary?: string | null
  decisionsJson: string
  changesJson: string
  contradictionsJson: string
  recommendedActionsJson: string
  sourceRefsJson: string
  compiledAt: number
  updatedAt: number
}
