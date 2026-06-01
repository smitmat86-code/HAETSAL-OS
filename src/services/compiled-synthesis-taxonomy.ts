export type CompiledDocumentFamily =
  | 'entity'
  | 'fact'
  | 'relationship'
  | 'dossier'
  | 'context_pack'
  | 'decision_log'
  | 'what_changed'

export type CompiledDocumentAudience =
  | 'human'
  | 'agent'
  | 'hybrid'
  | 'human_readable'
  | 'agent_reusable'
  | 'chief_of_staff'
  | 'specialist_agent'

export type CompiledArtifactFormat = 'markdown' | 'json' | 'html'
export type CompiledContradictionStatus = 'open' | 'noted' | 'resolved'
export type CompiledContradictionSeverity = 'low' | 'medium' | 'high'
export type CompiledContradictionFreshness = 'fresh' | 'recent' | 'stale'
export type CompiledDossierKind = 'person_dossier' | 'project_dossier' | 'topic_dossier'
export type CompiledChangeViewKind = 'decision_log' | 'what_changed'
