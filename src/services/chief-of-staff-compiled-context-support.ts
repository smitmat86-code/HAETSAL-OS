import type {
  AgentContextBundle,
  CompiledContextAssetUsage,
  CompiledContextMetadata,
  ContextGap,
  PrepareContextForAgentInput,
} from '../types/chief-of-staff-context'
import type {
  CompiledChangeViewReadModel,
  CompiledContextPackReadModel,
  CompiledDossierReadModel,
} from './compiled-synthesis'
import { linkedSourceCount } from './chief-of-staff-compiled-context-provenance'
import { slugifyStableSegment } from './compiled-synthesis-utils'

export type Freshness = CompiledContextAssetUsage['freshness']
export type Completeness = CompiledContextAssetUsage['completeness']
export type CompiledAssetKind = CompiledContextAssetUsage['asset']
export type ReadResult<T> = { stableKey: string; value: T | null; errors: string[] }

export interface LoadedCompiledChiefOfStaffAssets {
  contextPackRead: ReadResult<CompiledContextPackReadModel>
  dossierRead: ReadResult<CompiledDossierReadModel>
  whatChangedRead: ReadResult<CompiledChangeViewReadModel>
  decisionLogRead: ReadResult<CompiledChangeViewReadModel>
  contextPackUsage: CompiledContextAssetUsage
  dossierUsage: CompiledContextAssetUsage
  whatChangedUsage: CompiledContextAssetUsage
  decisionLogUsage: CompiledContextAssetUsage
  metadata: CompiledContextMetadata
}

export const COMPILED_CONTEXT_STALE_MS = 7 * 24 * 60 * 60 * 1000
export const COMPILED_FRESHNESS_POLICY = 'Prefer source-linked, agent-usable compiled context packs younger than 7 days; augment with fresh compiled dossiers and change views when available; fall back to runtime composition when the compiled context pack is missing, stale, or incomplete.'

export function compiledCandidateKeys(input: PrepareContextForAgentInput): Record<'contextPack' | 'dossier' | 'whatChanged' | 'decisionLog', string[]> {
  const slug = slugifyStableSegment(input.target)
  const subjectKind: 'person' | 'project' = input.intent === 'person' ? 'person' : 'project'
  const uniqKeys = (...values: string[]) => [...new Set(values.filter(Boolean))]
  return {
    contextPack: uniqKeys(`context-pack:chief-of-staff:${slug}`, `context-pack:${subjectKind}:${slug}`),
    dossier: uniqKeys(`dossier:${subjectKind}:${slug}`),
    whatChanged: uniqKeys(`what-changed:${subjectKind}:${slug}`, `what-changed:${slug}`),
    decisionLog: uniqKeys(`decision-log:${subjectKind}:${slug}`, `decision-log:${slug}`),
  }
}

export async function readFirstAvailable<T>(stableKeys: string[], reader: (stableKey: string) => Promise<T | null>): Promise<ReadResult<T>> {
  const errors: string[] = []
  for (const stableKey of stableKeys) {
    try {
      const value = await reader(stableKey)
      if (value) return { stableKey, value, errors }
    } catch (error) {
      errors.push(`${stableKey}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { stableKey: stableKeys[0] ?? '', value: null, errors }
}

export function freshnessFrom(compiledAt: number | null): Freshness {
  if (!compiledAt) return 'unknown'
  return Date.now() - compiledAt > COMPILED_CONTEXT_STALE_MS ? 'stale' : 'fresh'
}

export function contextPackCompleteness(view: CompiledContextPackReadModel | null): Completeness {
  if (!view) return 'missing'
  const hasContent = Boolean(
    view.contextPack.situation?.trim()
    || view.contextPack.summary?.trim()
    || view.contextPack.criticalFacts.length
    || view.contextPack.recentChanges.length
    || view.contextPack.decisions.length
    || view.contextPack.recommendedActions.length,
  )
  if (view.contextPack.agentUsable && hasContent && linkedSourceCount(view.contextPack.sourceRefs, view.sources) > 0) return 'complete'
  return hasContent ? 'partial' : 'missing'
}

export function dossierCompleteness(view: CompiledDossierReadModel | null): Completeness {
  if (!view) return 'missing'
  const hasContent = Boolean(
    view.dossier.whyItMatters?.trim()
    || view.dossier.currentState?.trim()
    || view.dossier.keyFacts.length
    || view.dossier.keyRelationships.length
    || view.dossier.recentUpdates.length
    || view.dossier.openQuestions.length,
  )
  if (hasContent && linkedSourceCount(view.dossier.sourceRefs, view.sources) > 0) return 'complete'
  return hasContent ? 'partial' : 'missing'
}

export function changeViewCompleteness(view: CompiledChangeViewReadModel | null): Completeness {
  if (!view) return 'missing'
  const hasContent = Boolean(
    view.changeView.decisions.length
    || view.changeView.changes.length
    || view.changeView.contradictions.length
    || view.changeView.recommendedActions.length,
  )
  if (hasContent && linkedSourceCount(view.changeView.sourceRefs, view.sources) > 0) return 'complete'
  return hasContent ? 'partial' : 'missing'
}

export function assetUsage(
  asset: CompiledAssetKind,
  stableKey: string,
  title: string | null,
  compiledAt: number | null,
  sourceCount: number,
  completeness: Completeness,
  used: boolean,
): CompiledContextAssetUsage {
  return {
    asset,
    stableKey,
    available: completeness !== 'missing',
    used,
    title,
    compiledAt,
    freshness: freshnessFrom(compiledAt),
    completeness,
    sourceCount,
  }
}

export function buildCompiledConfidence(metadata: CompiledContextMetadata, gaps: ContextGap[]): AgentContextBundle['confidence'] {
  const usedAssets = metadata.assets.filter((asset) => asset.used)
  const hasAugment = usedAssets.some((asset) => asset.asset !== 'context_pack')
  const hasStale = usedAssets.some((asset) => asset.freshness === 'stale') || gaps.some((gap) => gap.kind === 'stale')
  const level = usedAssets.length && !hasStale && hasAugment ? 'high' : usedAssets.length ? 'medium' : 'low'
  return {
    level,
    rationale: `${usedAssets.length} compiled asset(s) grounded the bundle; ${metadata.fallbackUsed ? 'runtime fallback was still required.' : hasStale ? 'one or more compiled assets were stale.' : 'no runtime fallback was required.'}`,
  }
}
