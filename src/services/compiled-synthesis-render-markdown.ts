import type { AssembledProjectCompiledSynthesis } from './compiled-synthesis-compiler-types'

function renderSection(title: string, items: string[]): string {
  return [
    `## ${title}`,
    ...(items.length > 0 ? items.map(item => `- ${item}`) : ['- None noted in the selected canonical sources.']),
  ].join('\n')
}

export function renderProjectDossierMarkdown(assembled: AssembledProjectCompiledSynthesis): string {
  return [
    `# ${assembled.dossier.title}`,
    '',
    `Compiled from ${assembled.sourceRefs.length} canonical source(s).`,
    '',
    '## Why It Matters',
    assembled.dossier.whyItMatters,
    '',
    '## Current State',
    assembled.dossier.currentState,
    '',
    renderSection('Key Facts', assembled.dossier.keyFacts.map(item => `${item.label}: ${item.summary}`)),
    '',
    renderSection('Key Relationships', assembled.dossier.keyRelationships.map(item => `${item.label}: ${item.summary}`)),
    '',
    renderSection('Recent Updates', assembled.dossier.recentUpdates.map(item => item.summary)),
    '',
    renderSection('Open Questions', assembled.dossier.openQuestions.map(item => item.question)),
    '',
    renderSection('Contradictions', assembled.dossier.contradictions.map(item => item.summary)),
    '',
    renderSection('Recommended Actions', assembled.dossier.recommendedActions.map(item => item.summary)),
    '',
    renderSection('Source Truth', assembled.sourceRefs.map(item => item.label ?? item.canonicalDocumentId ?? 'canonical source')),
  ].join('\n')
}

export function renderProjectContextPackMarkdown(assembled: AssembledProjectCompiledSynthesis): string {
  return [
    `# ${assembled.contextPack.title}`,
    '',
    assembled.contextPack.situation,
    '',
    renderSection('Critical Facts', assembled.contextPack.criticalFacts.map(item => `${item.label}: ${item.summary}`)),
    '',
    renderSection('Recent Changes', assembled.contextPack.recentChanges.map(item => item.summary)),
    '',
    renderSection('Decisions', assembled.contextPack.decisions.map(item => item.summary)),
    '',
    renderSection('Contradictions', assembled.contextPack.contradictions.map(item => item.summary)),
    '',
    renderSection('Recommended Actions', assembled.contextPack.recommendedActions.map(item => item.summary)),
  ].join('\n')
}

export function renderWhatChangedMarkdown(assembled: AssembledProjectCompiledSynthesis): string {
  return [
    `# ${assembled.whatChanged.title}`,
    '',
    assembled.whatChanged.summary,
    '',
    renderSection('Changes', assembled.whatChanged.changes.map(item => item.summary)),
    '',
    renderSection('Decisions In Force', assembled.whatChanged.decisions.map(item => item.summary)),
    '',
    renderSection('Contradictions', assembled.whatChanged.contradictions.map(item => item.summary)),
    '',
    renderSection('Recommended Actions', assembled.whatChanged.recommendedActions.map(item => item.summary)),
  ].join('\n')
}
