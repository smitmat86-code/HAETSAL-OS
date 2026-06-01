import type { CompiledSynthesisBundle } from './compiled-synthesis-schema'
import type {
  CompiledSynthesisView,
  CompiledChangeView,
  CompiledContextPackView,
  CompiledContradictionView,
  CompiledDossierView,
} from './compiled-synthesis-models'
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

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch (error) {
    throw new Error(`Invalid compiled synthesis ${label}: ${String(error)}`)
  }
}

function parseList<T>(value: string, label: string): T[] {
  const parsed = parseJson<unknown>(value, label)
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid compiled synthesis ${label}: expected array`)
  }
  return parsed as T[]
}

function parseContradictionView(row: CompiledSynthesisBundle['contradictions'][number]): CompiledContradictionView {
  return {
    record: row,
    stableKey: row.stable_key,
    scope: row.scope,
    title: row.title,
    contradictionKind: row.contradiction_kind,
    conflictScope: row.conflict_scope,
    severity: row.severity,
    freshness: row.freshness,
    summary: row.summary,
    status: row.status,
    leftFactId: row.left_fact_id,
    rightFactId: row.right_fact_id,
    leftClaim: parseJson<CompiledContradictionClaim>(row.left_claim_json, 'contradiction.left_claim_json'),
    rightClaim: parseJson<CompiledContradictionClaim>(row.right_claim_json, 'contradiction.right_claim_json'),
    suggestedResolution: row.suggested_resolution,
    resolutionSummary: row.resolution_summary,
  }
}

function parseDossier(row: CompiledSynthesisBundle['dossier']): CompiledDossierView | null {
  if (!row) return null
  return {
    record: row,
    dossierKind: row.dossier_kind,
    subjectType: row.subject_type,
    subjectStableKey: row.subject_stable_key,
    subjectName: row.subject_name,
    whyItMatters: row.why_it_matters,
    currentState: row.current_state,
    keyFacts: parseList<CompiledFactSectionItem>(row.key_facts_json, 'dossier.key_facts_json'),
    keyRelationships: parseList<CompiledRelationshipSectionItem>(row.key_relationships_json, 'dossier.key_relationships_json'),
    recentUpdates: parseList<CompiledRecentChangeItem>(row.recent_updates_json, 'dossier.recent_updates_json'),
    openQuestions: parseList<CompiledOpenQuestionItem>(row.open_questions_json, 'dossier.open_questions_json'),
    contradictions: parseList<CompiledContradictionSectionRef>(row.contradiction_refs_json, 'dossier.contradiction_refs_json'),
    recommendedActions: parseList<CompiledRecommendedActionItem>(row.recommended_actions_json, 'dossier.recommended_actions_json'),
    recommendedNextReading: parseList<CompiledRecommendedReadingItem>(row.recommended_reading_json, 'dossier.recommended_reading_json'),
    sourceRefs: parseList<CompiledSourceRefItem>(row.source_refs_json, 'dossier.source_refs_json'),
  }
}

function parseContextPack(row: CompiledSynthesisBundle['contextPack']): CompiledContextPackView | null {
  if (!row) return null
  return {
    record: row,
    packKind: row.pack_kind,
    title: row.title,
    summary: row.summary,
    agentUsable: row.agent_usable,
    humanUsable: row.human_usable,
    situation: row.situation,
    criticalFacts: parseList<CompiledFactSectionItem>(row.critical_facts_json, 'context_pack.critical_facts_json'),
    recentChanges: parseList<CompiledRecentChangeItem>(row.recent_changes_json, 'context_pack.recent_changes_json'),
    decisions: parseList<CompiledDecisionItem>(row.decisions_json, 'context_pack.decisions_json'),
    contradictions: parseList<CompiledContradictionSectionRef>(row.contradictions_json, 'context_pack.contradictions_json'),
    recommendedActions: parseList<CompiledRecommendedActionItem>(row.recommended_actions_json, 'context_pack.recommended_actions_json'),
    sourceRefs: parseList<CompiledSourceRefItem>(row.source_refs_json, 'context_pack.source_refs_json'),
  }
}

function parseChangeView(row: CompiledSynthesisBundle['changeView']): CompiledChangeView | null {
  if (!row) return null
  return {
    record: row,
    viewKind: row.view_kind,
    title: row.title,
    summary: row.summary,
    decisions: parseList<CompiledDecisionItem>(row.decisions_json, 'change_view.decisions_json'),
    changes: parseList<CompiledRecentChangeItem>(row.changes_json, 'change_view.changes_json'),
    contradictions: parseList<CompiledContradictionSectionRef>(row.contradictions_json, 'change_view.contradictions_json'),
    recommendedActions: parseList<CompiledRecommendedActionItem>(row.recommended_actions_json, 'change_view.recommended_actions_json'),
    sourceRefs: parseList<CompiledSourceRefItem>(row.source_refs_json, 'change_view.source_refs_json'),
  }
}

export function buildCompiledSynthesisView(bundle: CompiledSynthesisBundle): CompiledSynthesisView {
  return {
    document: bundle.document,
    sources: bundle.sources,
    artifacts: bundle.artifacts,
    entities: bundle.entities,
    facts: bundle.facts,
    relationships: bundle.relationships,
    contradictions: bundle.contradictions.map(parseContradictionView),
    dossier: parseDossier(bundle.dossier),
    contextPack: parseContextPack(bundle.contextPack),
    changeView: parseChangeView(bundle.changeView),
  }
}
