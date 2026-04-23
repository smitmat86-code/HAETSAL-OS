import type { AssembledProjectCompiledSynthesis, CanonicalCompilationSelection } from './compiled-synthesis-compiler-types'
import type { CompiledDecisionItem, CompiledOpenQuestionItem, CompiledRecommendedActionItem, CompiledRecentChangeItem } from './compiled-synthesis-section-types'
import { buildContradictionInputs, buildFactInputs, buildRelationshipInputs } from './compiled-synthesis-assemble-support'
import { collectSelectionSignals, summarizeRecentChanges } from './compiled-synthesis-signal-parser'
import { stableSubjectSegment } from './compiled-synthesis-utils'

function firstNonEmpty(values: string[], fallback: string): string {
  return values.map(value => value.trim()).find(Boolean) ?? fallback
}

export function assembleProjectCompiledSynthesis(
  selection: CanonicalCompilationSelection,
): AssembledProjectCompiledSynthesis {
  const stableSegment = stableSubjectSegment(selection.subject.stableKey, selection.subject.name)
  const subjectStableKey = selection.subject.stableKey
  const parsed = collectSelectionSignals(selection.documents)
  const factSignals = parsed.facts
  const relationshipSignals = parsed.relationships
  const changeSignals = parsed.changes
  const decisionSignals = parsed.decisions
  const questionSignals = parsed.questions
  const actionSignals = parsed.actions
  const contradictionSignals = parsed.contradictions
  const whyItMattersLines = parsed.whyItMatters
  const currentStateLines = parsed.currentState
  const currentStateSummary = firstNonEmpty(currentStateLines, `Compiled project subject for ${selection.subject.name}.`)
  const { facts, keyFacts } = buildFactInputs(stableSegment, selection.subject.scope, subjectStableKey, factSignals)
  const { entities, relationships, keyRelationships } = buildRelationshipInputs(
    stableSegment,
    selection.subject.scope,
    subjectStableKey,
    selection.subject.name,
    currentStateSummary,
    relationshipSignals,
  )

  const recentUpdates: CompiledRecentChangeItem[] = changeSignals
    .sort((left, right) => (right.changedAt ?? 0) - (left.changedAt ?? 0))
    .slice(0, 6)
    .map(signal => ({
      summary: signal.summary,
      changeKind: signal.changeKind,
      changedAt: signal.changedAt,
    }))

  const decisions: CompiledDecisionItem[] = decisionSignals
    .slice(0, 6)
    .map(signal => ({
      summary: signal.summary,
      decisionStableKey: `decision:project:${stableSegment}:${signal.decisionKey}`,
      status: 'active',
    }))

  const openQuestions: CompiledOpenQuestionItem[] = questionSignals
    .slice(0, 5)
    .map(signal => ({
      question: signal.question,
      owner: signal.owner,
      status: 'open',
    }))

  const recommendedActions: CompiledRecommendedActionItem[] = actionSignals
    .slice(0, 6)
    .map(signal => ({
      summary: signal.summary,
      owner: signal.owner,
      status: 'pending',
    }))
  const { contradictions, contradictionRefs } = buildContradictionInputs(stableSegment, selection.subject.name, selection.subject.scope, facts, contradictionSignals, recommendedActions)
  const whyItMatters = firstNonEmpty(whyItMattersLines, `${selection.subject.name} keeps appearing in recent canonical memory and still needs a stable compiled operating view.`)
  const currentState = firstNonEmpty(
    currentStateLines,
    keyFacts[0]?.summary ?? `Canonical truth is present for ${selection.subject.name}, but the current state remains lightly structured.`,
  )

  return {
    tenantId: selection.tenantId,
    subject: selection.subject,
    scope: selection.subject.scope,
    stableSegment,
    sourceFingerprint: selection.sourceFingerprint,
    artifactVersion: selection.artifactVersion,
    sourceLinks: selection.sourceLinks,
    sourceRefs: selection.sourceRefs,
    entities,
    facts,
    relationships,
    contradictions,
    dossier: {
      stableKey: `dossier:project:${stableSegment}`,
      title: `${selection.subject.name} Project Dossier`,
      summary: currentState,
      whyItMatters,
      currentState,
      keyFacts,
      keyRelationships: keyRelationships.slice(0, 6),
      recentUpdates,
      openQuestions,
      contradictions: contradictionRefs,
      recommendedActions,
      recommendedReading: [
        {
          title: `${selection.subject.name} project dossier`,
          note: 'Primary human-readable project render.',
          artifactRole: 'dossier_markdown',
        },
      ],
    },
    contextPack: {
      stableKey: `context-pack:project:${stableSegment}`,
      title: `${selection.subject.name} Project Context Pack`,
      summary: `Compact project context pack compiled from ${selection.documents.length} canonical source(s).`,
      situation: `${currentState} ${summarizeRecentChanges(recentUpdates)}`.trim(),
      criticalFacts: keyFacts.slice(0, 6),
      recentChanges: recentUpdates,
      decisions,
      contradictions: contradictionRefs,
      recommendedActions,
    },
    whatChanged: {
      stableKey: `what-changed:project:${stableSegment}`,
      title: `${selection.subject.name} What Changed`,
      summary: summarizeRecentChanges(recentUpdates),
      changes: recentUpdates,
      decisions,
      contradictions: contradictionRefs,
      recommendedActions,
    },
  }
}
