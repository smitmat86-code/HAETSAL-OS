import { stableSubjectSegment } from './compiled-synthesis-utils'
import type {
  CanonicalCompiledChangeEvent,
  CompiledRefreshDispatchJob,
  CompiledRefreshTarget,
  PlannedCompiledRefresh,
} from './compiled-synthesis-trigger-types'

function projectTargetsFor(event: CanonicalCompiledChangeEvent): {
  targets: CompiledRefreshTarget[]
  dispatchJob: CompiledRefreshDispatchJob
}[] {
  return event.subjectHints
    .filter((hint) => hint.subjectKind === 'project' && hint.scope === 'projects')
    .map((hint) => {
      const stableSegment = stableSubjectSegment(hint.stableKey, hint.name)
      const targets: CompiledRefreshTarget[] = [
        {
          family: 'dossier',
          stableKey: `dossier:project:${stableSegment}`,
          scope: 'projects',
          subjectStableKey: hint.stableKey,
          subjectKind: 'project',
          reason: `${event.changeType} touched project truth for ${hint.name}, so the project dossier should refresh.`,
        },
        {
          family: 'context_pack',
          stableKey: `context-pack:project:${stableSegment}`,
          scope: 'projects',
          subjectStableKey: hint.stableKey,
          subjectKind: 'project',
          reason: `${event.changeType} touched project truth for ${hint.name}, so the project context pack should refresh.`,
        },
        {
          family: 'what_changed',
          stableKey: `what-changed:project:${stableSegment}`,
          scope: 'projects',
          subjectStableKey: hint.stableKey,
          subjectKind: 'project',
          reason: `${event.changeType} touched project truth for ${hint.name}, so the project change view should refresh.`,
        },
      ]
      return {
        targets,
        dispatchJob: {
          jobKind: 'project_compilation',
          subject: {
            stableKey: hint.stableKey,
            name: hint.name,
            scope: 'projects',
            keywords: hint.keywords,
          },
          targetStableKeys: targets.map((target) => target.stableKey),
          reason: `Refresh the project compilation bundle for ${hint.name} from canonical ${event.changeType}.`,
        },
      }
    })
}

export function planTargetedCompiledRefresh(event: CanonicalCompiledChangeEvent): PlannedCompiledRefresh {
  const projectGroups = projectTargetsFor(event)
  return {
    event,
    targets: projectGroups.flatMap((group) => group.targets),
    dispatchJobs: projectGroups.map((group) => group.dispatchJob),
  }
}
