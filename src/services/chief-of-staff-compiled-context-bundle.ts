import type { PrepareContextForAgentInput, ContextGap } from '../types/chief-of-staff-context'
import {
  AssembledContextCore,
  buildSummary,
  dedupeSources,
  uniq,
} from './chief-of-staff-context-shared'
import {
  buildCompiledConfidence,
  type LoadedCompiledChiefOfStaffAssets,
} from './chief-of-staff-compiled-context-support'
import {
  compiledEvidenceBlock,
  linkedSourceRefs,
} from './chief-of-staff-compiled-context-provenance'
import {
  addReadErrorGap,
  addSkippedAssetGap,
} from './chief-of-staff-compiled-context-gaps'

export function buildCompiledChiefOfStaffBundle(
  input: PrepareContextForAgentInput,
  assets: LoadedCompiledChiefOfStaffAssets,
): AssembledContextCore {
  const usedDossier = assets.dossierUsage.used ? assets.dossierRead.value : null
  const usedWhatChanged = assets.whatChangedUsage.used ? assets.whatChangedRead.value : null
  const usedDecisionLog = assets.decisionLogUsage.used ? assets.decisionLogRead.value : null

  const evidence = [
    compiledEvidenceBlock(
      assets.contextPackRead.stableKey,
      assets.contextPackRead.value!.contextPack.title,
      linkedSourceRefs(
        assets.contextPackRead.value!.contextPack.sourceRefs,
        assets.contextPackRead.value!.sources,
      ),
      'compiled-first context pack',
    ),
    usedDossier
      ? compiledEvidenceBlock(
        assets.dossierRead.stableKey,
        usedDossier.dossier.subjectName,
        linkedSourceRefs(usedDossier.dossier.sourceRefs, usedDossier.sources),
        'compiled dossier augmentation',
      )
      : null,
    usedWhatChanged
      ? compiledEvidenceBlock(
        assets.whatChangedRead.stableKey,
        usedWhatChanged.changeView.title,
        linkedSourceRefs(usedWhatChanged.changeView.sourceRefs, usedWhatChanged.sources),
        'compiled recent-change augmentation',
      )
      : null,
    usedDecisionLog
      ? compiledEvidenceBlock(
        assets.decisionLogRead.stableKey,
        usedDecisionLog.changeView.title,
        linkedSourceRefs(usedDecisionLog.changeView.sourceRefs, usedDecisionLog.sources),
        'compiled decision-view augmentation',
      )
      : null,
  ].filter((block): block is NonNullable<(typeof evidence)[number]> => Boolean(block))
  const sources = dedupeSources(evidence.flatMap((block) => block.items))

  const changeItems = [
    ...assets.contextPackRead.value!.contextPack.recentChanges,
    ...(usedDossier?.dossier.recentUpdates ?? []),
    ...(usedWhatChanged?.changeView.changes ?? []),
  ].sort((left, right) => (right.changedAt ?? 0) - (left.changedAt ?? 0))
  const relationships = uniq(usedDossier?.dossier.keyRelationships.map((item) => item.summary) ?? [], 4)
  const decisionHighlights = [
    ...assets.contextPackRead.value!.contextPack.decisions.map((item) => `Decision: ${item.summary}`),
    ...(usedDecisionLog?.changeView.decisions.map((item) => `Decision: ${item.summary}`) ?? []),
  ]
  const highlights = uniq([
    assets.contextPackRead.value!.contextPack.situation,
    ...decisionHighlights,
    usedDossier?.dossier.whyItMatters ?? null,
    usedDossier?.dossier.currentState ?? null,
    ...assets.contextPackRead.value!.contextPack.criticalFacts.map((item) => item.summary),
    ...(usedDossier?.dossier.keyFacts.map((item) => item.summary) ?? []),
  ], 4)
  const openLoops = uniq([
    ...(usedDossier?.dossier.openQuestions.map((item) => item.question) ?? []),
    ...assets.contextPackRead.value!.contextPack.recommendedActions.map((item) => item.summary),
    ...(usedWhatChanged?.changeView.recommendedActions.map((item) => item.summary) ?? []),
    ...(usedDecisionLog?.changeView.recommendedActions.map((item) => item.summary) ?? []),
  ], 4)
  const risks = uniq([
    ...assets.contextPackRead.value!.contextPack.contradictions.map((item) => item.summary),
    ...(usedDossier?.dossier.contradictions.map((item) => item.summary) ?? []),
    ...(usedWhatChanged?.changeView.contradictions.map((item) => item.summary) ?? []),
    ...(usedDecisionLog?.changeView.contradictions.map((item) => item.summary) ?? []),
  ], 4)

  const gaps: ContextGap[] = []
  addSkippedAssetGap(gaps, input.target, 'dossier', assets.dossierUsage, Boolean(assets.dossierRead.value))
  addSkippedAssetGap(gaps, input.target, 'recent-change view', assets.whatChangedUsage, Boolean(assets.whatChangedRead.value))
  addSkippedAssetGap(gaps, input.target, 'decision view', assets.decisionLogUsage, Boolean(assets.decisionLogRead.value))
  addReadErrorGap(gaps, input.target, 'dossier', assets.dossierRead.errors)
  addReadErrorGap(gaps, input.target, 'recent-change', assets.whatChangedRead.errors)
  addReadErrorGap(gaps, input.target, 'decision-view', assets.decisionLogRead.errors)

  const recentChanges = uniq(changeItems.map((item) => item.summary), 4)
  const timeline = uniq(changeItems.map((item) => `${item.changedAt ? new Date(item.changedAt).toISOString().slice(0, 10) : 'unknown'}: ${item.summary}`), 4)

  return {
    agent: input.agent,
    intent: input.intent,
    target: input.target,
    scope: input.scope ?? null,
    summary: buildSummary(input.target, input.intent, highlights, relationships, gaps),
    confidence: buildCompiledConfidence(assets.metadata, gaps),
    highlights,
    recentChanges,
    openLoops,
    risks,
    timeline,
    relationships,
    followUpQuestions: uniq([...(usedDossier?.dossier.openQuestions.map((item) => item.question) ?? []), !relationships.length ? `What relationship context is still missing for ${input.target}?` : null, !recentChanges.length ? `What changed most recently for ${input.target}?` : null], 3),
    gaps,
    sources,
    evidence,
  }
}
