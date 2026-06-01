import type { CompiledContextAssetUsage, ContextGap } from '../types/chief-of-staff-context'

export function addSkippedAssetGap(
  gaps: ContextGap[],
  target: string,
  label: string,
  usage: CompiledContextAssetUsage,
  available: boolean,
): void {
  if (!available || usage.used) return
  gaps.push({
    kind: usage.freshness === 'stale' ? 'stale' : 'uncertain',
    mode: 'composed',
    message: usage.freshness === 'stale'
      ? `Compiled ${label} for ${target} was skipped because it is older than the 7 day freshness window.`
      : `Compiled ${label} for ${target} was present but incomplete, so it was not used.`,
  })
}

export function addReadErrorGap(
  gaps: ContextGap[],
  target: string,
  label: string,
  errors: string[],
): void {
  if (!errors.length) return
  gaps.push({
    kind: 'uncertain',
    mode: 'composed',
    message: `Compiled ${label} lookup encountered read errors for ${target}: ${errors.join('; ')}`,
  })
}
