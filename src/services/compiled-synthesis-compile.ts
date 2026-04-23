import type { Env } from '../types/env'
import { persistCompiledSynthesis } from './compiled-synthesis-persist'
import { assembleProjectCompiledSynthesis } from './compiled-synthesis-assemble'
import type {
  CompileProjectSynthesisFromCanonicalTruthInput,
  CompileProjectSynthesisFromCanonicalTruthResult,
} from './compiled-synthesis-compiler-types'
import { renderProjectCompiledArtifacts } from './compiled-synthesis-render'
import { selectProjectCompilationSources } from './compiled-synthesis-source-truth'

export async function compileProjectSynthesisFromCanonicalTruth(
  input: CompileProjectSynthesisFromCanonicalTruthInput,
  env: Env,
): Promise<CompileProjectSynthesisFromCanonicalTruthResult> {
  const selection = await selectProjectCompilationSources(input, env)
  const assembled = assembleProjectCompiledSynthesis(selection)
  const rendered = renderProjectCompiledArtifacts(assembled)

  const dossier = await persistCompiledSynthesis({
    tenantId: input.tenantId,
    document: {
      stableKey: assembled.dossier.stableKey,
      family: 'dossier',
      scope: assembled.scope,
      title: assembled.dossier.title,
      summary: assembled.dossier.summary,
      audience: 'human_readable',
    },
    sources: assembled.sourceLinks,
    entities: assembled.entities,
    facts: assembled.facts,
    relationships: assembled.relationships,
    contradictions: assembled.contradictions,
    dossier: {
      stableKey: assembled.dossier.stableKey,
      scope: assembled.scope,
      dossierKind: 'project_dossier',
      subjectType: 'project',
      subjectStableKey: assembled.subject.stableKey,
      subjectName: assembled.subject.name,
      whyItMatters: assembled.dossier.whyItMatters,
      currentState: assembled.dossier.currentState,
      keyFacts: assembled.dossier.keyFacts,
      keyRelationships: assembled.dossier.keyRelationships,
      recentUpdates: assembled.dossier.recentUpdates,
      openQuestions: assembled.dossier.openQuestions,
      contradictions: assembled.dossier.contradictions,
      recommendedActions: assembled.dossier.recommendedActions,
      recommendedNextReading: assembled.dossier.recommendedReading,
      sourceRefs: assembled.sourceRefs,
    },
    artifacts: rendered.dossier,
  }, env)

  const contextPack = await persistCompiledSynthesis({
    tenantId: input.tenantId,
    document: {
      stableKey: assembled.contextPack.stableKey,
      family: 'context_pack',
      scope: assembled.scope,
      title: assembled.contextPack.title,
      summary: assembled.contextPack.summary,
      audience: 'chief_of_staff',
    },
    sources: assembled.sourceLinks,
    contextPack: {
      stableKey: assembled.contextPack.stableKey,
      scope: assembled.scope,
      packKind: 'project_context_pack',
      title: assembled.contextPack.title,
      summary: assembled.contextPack.summary,
      agentUsable: true,
      humanUsable: true,
      situation: assembled.contextPack.situation,
      criticalFacts: assembled.contextPack.criticalFacts,
      recentChanges: assembled.contextPack.recentChanges,
      decisions: assembled.contextPack.decisions,
      contradictions: assembled.contextPack.contradictions,
      recommendedActions: assembled.contextPack.recommendedActions,
      sourceRefs: assembled.sourceRefs,
    },
    artifacts: rendered.contextPack,
  }, env)

  const whatChanged = await persistCompiledSynthesis({
    tenantId: input.tenantId,
    document: {
      stableKey: assembled.whatChanged.stableKey,
      family: 'what_changed',
      scope: assembled.scope,
      title: assembled.whatChanged.title,
      summary: assembled.whatChanged.summary,
      audience: 'specialist_agent',
    },
    sources: assembled.sourceLinks,
    changeView: {
      stableKey: assembled.whatChanged.stableKey,
      scope: assembled.scope,
      viewKind: 'what_changed',
      title: assembled.whatChanged.title,
      summary: assembled.whatChanged.summary,
      changes: assembled.whatChanged.changes,
      decisions: assembled.whatChanged.decisions,
      contradictions: assembled.whatChanged.contradictions,
      recommendedActions: assembled.whatChanged.recommendedActions,
      sourceRefs: assembled.sourceRefs,
    },
    artifacts: rendered.whatChanged,
  }, env)

  return {
    sourceFingerprint: selection.sourceFingerprint,
    sourceCount: selection.documents.length,
    dossier: {
      stableKey: assembled.dossier.stableKey,
      result: dossier,
    },
    contextPack: {
      stableKey: assembled.contextPack.stableKey,
      result: contextPack,
    },
    whatChanged: {
      stableKey: assembled.whatChanged.stableKey,
      result: whatChanged,
    },
  }
}
