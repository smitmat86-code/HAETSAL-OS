import type {
  CompiledChangeViewKind,
  CompiledContradictionFreshness,
  CompiledContradictionSeverity,
  CompiledContradictionStatus,
  CompiledDossierKind,
} from './compiled-synthesis-taxonomy'

export interface CompiledContradictionRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  left_fact_id: string | null
  right_fact_id: string | null
  title: string | null
  contradiction_kind: string
  conflict_scope: string | null
  severity: CompiledContradictionSeverity
  freshness: CompiledContradictionFreshness
  summary: string
  status: CompiledContradictionStatus
  left_claim_json: string
  right_claim_json: string
  suggested_resolution: string | null
  resolution_summary: string | null
  compiled_at: number
  created_at: number
  updated_at: number
}

export interface CompiledDossierRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  dossier_kind: CompiledDossierKind
  subject_type: string
  subject_stable_key: string
  subject_name: string
  why_it_matters: string | null
  current_state: string | null
  key_facts_json: string
  key_relationships_json: string
  recent_updates_json: string
  open_questions_json: string
  contradiction_refs_json: string
  recommended_actions_json: string
  recommended_reading_json: string
  source_refs_json: string
  compiled_at: number
  created_at: number
  updated_at: number
}

export interface CompiledContextPackRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  pack_kind: string
  title: string
  summary: string | null
  agent_usable: boolean
  human_usable: boolean
  situation: string | null
  critical_facts_json: string
  recent_changes_json: string
  decisions_json: string
  contradictions_json: string
  recommended_actions_json: string
  source_refs_json: string
  compiled_at: number
  created_at: number
  updated_at: number
}

export interface CompiledChangeViewRecord {
  id: string
  tenant_id: string
  compiled_document_id: string
  stable_key: string
  scope: string
  view_kind: CompiledChangeViewKind
  title: string
  summary: string | null
  decisions_json: string
  changes_json: string
  contradictions_json: string
  recommended_actions_json: string
  source_refs_json: string
  compiled_at: number
  created_at: number
  updated_at: number
}
