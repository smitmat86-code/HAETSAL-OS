import type { CompiledSynthesisStore } from './compiled-synthesis-repository'
import type {
  PersistCompiledSynthesisInput,
  PersistCompiledSynthesisResult,
} from './compiled-synthesis-service-types'
import { normalizeJson, trimRequired } from './compiled-synthesis-utils'

export async function persistOutputRows(
  store: CompiledSynthesisStore,
  input: PersistCompiledSynthesisInput,
  compiledDocumentId: string,
  compiledAt: number,
  result: PersistCompiledSynthesisResult,
): Promise<void> {
  if (input.dossier) {
    result.dossierId = (await store.upsertCompiledDossier({
      tenantId: input.tenantId,
      compiledDocumentId,
      stableKey: trimRequired(input.dossier.stableKey, 'Compiled dossier stable key'),
      scope: trimRequired(input.dossier.scope, 'Compiled dossier scope'),
      dossierKind: input.dossier.dossierKind,
      subjectType: trimRequired(input.dossier.subjectType, 'Compiled dossier subject type'),
      subjectStableKey: trimRequired(input.dossier.subjectStableKey, 'Compiled dossier subject stable key'),
      subjectName: trimRequired(input.dossier.subjectName, 'Compiled dossier subject name'),
      whyItMatters: input.dossier.whyItMatters ?? null,
      currentState: input.dossier.currentState ?? null,
      keyFactsJson: normalizeJson(input.dossier.keyFacts ?? []),
      keyRelationshipsJson: normalizeJson(input.dossier.keyRelationships ?? []),
      recentUpdatesJson: normalizeJson(input.dossier.recentUpdates ?? []),
      openQuestionsJson: normalizeJson(input.dossier.openQuestions ?? []),
      contradictionRefsJson: normalizeJson(input.dossier.contradictions ?? []),
      recommendedActionsJson: normalizeJson(input.dossier.recommendedActions ?? []),
      recommendedReadingJson: normalizeJson(input.dossier.recommendedNextReading ?? []),
      sourceRefsJson: normalizeJson(input.dossier.sourceRefs ?? []),
      compiledAt,
      updatedAt: compiledAt,
    })).id
  }

  if (input.contextPack) {
    result.contextPackId = (await store.upsertCompiledContextPack({
      tenantId: input.tenantId,
      compiledDocumentId,
      stableKey: trimRequired(input.contextPack.stableKey, 'Compiled context-pack stable key'),
      scope: trimRequired(input.contextPack.scope, 'Compiled context-pack scope'),
      packKind: trimRequired(input.contextPack.packKind, 'Compiled context-pack kind'),
      title: trimRequired(input.contextPack.title, 'Compiled context-pack title'),
      summary: input.contextPack.summary ?? null,
      agentUsable: input.contextPack.agentUsable,
      humanUsable: input.contextPack.humanUsable,
      situation: input.contextPack.situation ?? null,
      criticalFactsJson: normalizeJson(input.contextPack.criticalFacts ?? []),
      recentChangesJson: normalizeJson(input.contextPack.recentChanges ?? []),
      decisionsJson: normalizeJson(input.contextPack.decisions ?? []),
      contradictionsJson: normalizeJson(input.contextPack.contradictions ?? []),
      recommendedActionsJson: normalizeJson(input.contextPack.recommendedActions ?? []),
      sourceRefsJson: normalizeJson(input.contextPack.sourceRefs ?? []),
      compiledAt,
      updatedAt: compiledAt,
    })).id
  }

  if (input.changeView) {
    result.changeViewId = (await store.upsertCompiledChangeView({
      tenantId: input.tenantId,
      compiledDocumentId,
      stableKey: trimRequired(input.changeView.stableKey, 'Compiled change-view stable key'),
      scope: trimRequired(input.changeView.scope, 'Compiled change-view scope'),
      viewKind: input.changeView.viewKind,
      title: trimRequired(input.changeView.title, 'Compiled change-view title'),
      summary: input.changeView.summary ?? null,
      decisionsJson: normalizeJson(input.changeView.decisions ?? []),
      changesJson: normalizeJson(input.changeView.changes ?? []),
      contradictionsJson: normalizeJson(input.changeView.contradictions ?? []),
      recommendedActionsJson: normalizeJson(input.changeView.recommendedActions ?? []),
      sourceRefsJson: normalizeJson(input.changeView.sourceRefs ?? []),
      compiledAt,
      updatedAt: compiledAt,
    })).id
  }
}
