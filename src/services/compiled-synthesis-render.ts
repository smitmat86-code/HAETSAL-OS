import type {
  AssembledProjectCompiledSynthesis,
  RenderedProjectCompiledArtifacts,
} from './compiled-synthesis-compiler-types'
import {
  renderProjectContextPackMarkdown,
  renderProjectDossierMarkdown,
  renderWhatChangedMarkdown,
} from './compiled-synthesis-render-markdown'

export function renderProjectCompiledArtifacts(
  assembled: AssembledProjectCompiledSynthesis,
): RenderedProjectCompiledArtifacts {
  return {
    dossier: [
      {
        artifactRole: 'dossier_markdown',
        format: 'markdown',
        version: assembled.artifactVersion,
        contentEncrypted: renderProjectDossierMarkdown(assembled),
      },
      {
        artifactRole: 'dossier_json',
        format: 'json',
        version: assembled.artifactVersion,
        contentEncrypted: JSON.stringify({
          stableKey: assembled.dossier.stableKey,
          subject: assembled.subject,
          summary: assembled.dossier.summary,
          whyItMatters: assembled.dossier.whyItMatters,
          currentState: assembled.dossier.currentState,
          keyFacts: assembled.dossier.keyFacts,
          keyRelationships: assembled.dossier.keyRelationships,
          recentUpdates: assembled.dossier.recentUpdates,
          openQuestions: assembled.dossier.openQuestions,
          contradictions: assembled.dossier.contradictions,
          recommendedActions: assembled.dossier.recommendedActions,
          sourceRefs: assembled.sourceRefs,
          sourceFingerprint: assembled.sourceFingerprint,
        }),
      },
    ],
    contextPack: [
      {
        artifactRole: 'context_pack_markdown',
        format: 'markdown',
        version: assembled.artifactVersion,
        contentEncrypted: renderProjectContextPackMarkdown(assembled),
      },
      {
        artifactRole: 'context_pack_json',
        format: 'json',
        version: assembled.artifactVersion,
        contentEncrypted: JSON.stringify({
          stableKey: assembled.contextPack.stableKey,
          subject: assembled.subject,
          summary: assembled.contextPack.summary,
          situation: assembled.contextPack.situation,
          criticalFacts: assembled.contextPack.criticalFacts,
          recentChanges: assembled.contextPack.recentChanges,
          decisions: assembled.contextPack.decisions,
          contradictions: assembled.contextPack.contradictions,
          recommendedActions: assembled.contextPack.recommendedActions,
          sourceRefs: assembled.sourceRefs,
          sourceFingerprint: assembled.sourceFingerprint,
        }),
      },
    ],
    whatChanged: [
      {
        artifactRole: 'what_changed_markdown',
        format: 'markdown',
        version: assembled.artifactVersion,
        contentEncrypted: renderWhatChangedMarkdown(assembled),
      },
      {
        artifactRole: 'what_changed_json',
        format: 'json',
        version: assembled.artifactVersion,
        contentEncrypted: JSON.stringify({
          stableKey: assembled.whatChanged.stableKey,
          subject: assembled.subject,
          summary: assembled.whatChanged.summary,
          changes: assembled.whatChanged.changes,
          decisions: assembled.whatChanged.decisions,
          contradictions: assembled.whatChanged.contradictions,
          recommendedActions: assembled.whatChanged.recommendedActions,
          sourceRefs: assembled.sourceRefs,
          sourceFingerprint: assembled.sourceFingerprint,
        }),
      },
    ],
  }
}
