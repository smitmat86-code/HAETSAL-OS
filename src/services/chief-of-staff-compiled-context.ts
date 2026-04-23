import type { Env } from '../types/env'
import type {
  CompiledContextMetadata,
  PrepareContextForAgentInput,
} from '../types/chief-of-staff-context'
import { readCompiledChangeView, readCompiledContextPack, readCompiledDossier } from './compiled-synthesis'
import { buildCompiledChiefOfStaffBundle } from './chief-of-staff-compiled-context-bundle'
import {
  assetUsage,
  changeViewCompleteness,
  compiledCandidateKeys,
  COMPILED_FRESHNESS_POLICY,
  contextPackCompleteness,
  dossierCompleteness,
  freshnessFrom,
  readFirstAvailable,
} from './chief-of-staff-compiled-context-support'
import { linkedSourceCount } from './chief-of-staff-compiled-context-provenance'
import type { AssembledContextCore } from './chief-of-staff-context-shared'

export async function loadCompiledChiefOfStaffContext(
  input: PrepareContextForAgentInput,
  env: Env,
  tenantId: string,
): Promise<{ metadata: CompiledContextMetadata; bundle: AssembledContextCore | null } | null> {
  if (input.agent !== 'chief_of_staff') return null

  const candidates = compiledCandidateKeys(input)
  try {
    const [contextPackRead, dossierRead, whatChangedRead, decisionLogRead] = await Promise.all([
      readFirstAvailable(candidates.contextPack, (stableKey) => readCompiledContextPack(tenantId, stableKey, env)),
      readFirstAvailable(candidates.dossier, (stableKey) => readCompiledDossier(tenantId, stableKey, env)),
      readFirstAvailable(candidates.whatChanged, (stableKey) => readCompiledChangeView(tenantId, stableKey, env)),
      readFirstAvailable(candidates.decisionLog, (stableKey) => readCompiledChangeView(tenantId, stableKey, env)),
    ])
    const contextPackCompletenessLevel = contextPackCompleteness(contextPackRead.value)
    const contextPackFreshness = freshnessFrom(contextPackRead.value?.document.compiled_at ?? null)
    const contextPackUsed = Boolean(
      contextPackRead.value
      && contextPackCompletenessLevel === 'complete'
      && contextPackFreshness === 'fresh',
    )
    const dossierCompletenessLevel = dossierCompleteness(dossierRead.value)
    const dossierUsed = Boolean(
      contextPackUsed
      && dossierRead.value
      && dossierCompletenessLevel === 'complete'
      && freshnessFrom(dossierRead.value.document.compiled_at) === 'fresh',
    )
    const whatChangedCompletenessLevel = changeViewCompleteness(whatChangedRead.value)
    const whatChangedUsed = Boolean(
      contextPackUsed
      && whatChangedRead.value
      && whatChangedCompletenessLevel === 'complete'
      && freshnessFrom(whatChangedRead.value.document.compiled_at) === 'fresh',
    )
    const decisionLogCompletenessLevel = changeViewCompleteness(decisionLogRead.value)
    const decisionLogUsed = Boolean(
      contextPackUsed
      && decisionLogRead.value
      && decisionLogCompletenessLevel === 'complete'
      && freshnessFrom(decisionLogRead.value.document.compiled_at) === 'fresh',
    )

    const contextPackUsage = assetUsage(
      'context_pack',
      contextPackRead.stableKey,
      contextPackRead.value?.document.title ?? contextPackRead.value?.contextPack.title ?? null,
      contextPackRead.value?.document.compiled_at ?? null,
      contextPackRead.value ? linkedSourceCount(contextPackRead.value.contextPack.sourceRefs, contextPackRead.value.sources) : 0,
      contextPackCompletenessLevel,
      contextPackUsed,
    )
    const dossierUsage = assetUsage(
      'dossier',
      dossierRead.stableKey,
      dossierRead.value?.document.title ?? dossierRead.value?.dossier.subjectName ?? null,
      dossierRead.value?.document.compiled_at ?? null,
      dossierRead.value ? linkedSourceCount(dossierRead.value.dossier.sourceRefs, dossierRead.value.sources) : 0,
      dossierCompletenessLevel,
      dossierUsed,
    )
    const whatChangedUsage = assetUsage(
      'what_changed',
      whatChangedRead.stableKey,
      whatChangedRead.value?.document.title ?? whatChangedRead.value?.changeView.title ?? null,
      whatChangedRead.value?.document.compiled_at ?? null,
      whatChangedRead.value ? linkedSourceCount(whatChangedRead.value.changeView.sourceRefs, whatChangedRead.value.sources) : 0,
      whatChangedCompletenessLevel,
      whatChangedUsed,
    )
    const decisionLogUsage = assetUsage(
      'decision_log',
      decisionLogRead.stableKey,
      decisionLogRead.value?.document.title ?? decisionLogRead.value?.changeView.title ?? null,
      decisionLogRead.value?.document.compiled_at ?? null,
      decisionLogRead.value ? linkedSourceCount(decisionLogRead.value.changeView.sourceRefs, decisionLogRead.value.sources) : 0,
      decisionLogCompletenessLevel,
      decisionLogUsed,
    )
    const fallbackReason = !contextPackRead.value
      ? contextPackRead.errors.length
        ? `Compiled context-pack lookup failed for ${input.target}: ${contextPackRead.errors.join('; ')}`
        : `No compiled context pack was available for ${input.target}.`
      : contextPackFreshness === 'unknown'
        ? `Compiled context pack for ${input.target} is missing a compiled timestamp, so freshness could not be verified.`
      : contextPackFreshness === 'stale'
        ? `Compiled context pack for ${input.target} is older than the 7 day freshness window.`
        : `Compiled context pack for ${input.target} was incomplete for Chief-of-Staff use.`

    const metadata: CompiledContextMetadata = {
      mode: contextPackUsage.used ? 'compiled_first' : 'runtime_fallback',
      fallbackUsed: !contextPackUsage.used,
      fallbackReason: contextPackUsage.used ? null : fallbackReason,
      freshnessPolicy: COMPILED_FRESHNESS_POLICY,
      assets: [contextPackUsage, dossierUsage, whatChangedUsage, decisionLogUsage],
    }
    if (!contextPackUsage.used || !contextPackRead.value) return { metadata, bundle: null }

    const bundle = buildCompiledChiefOfStaffBundle(input, {
      contextPackRead,
      dossierRead,
      whatChangedRead,
      decisionLogRead,
      contextPackUsage,
      dossierUsage,
      whatChangedUsage,
      decisionLogUsage,
      metadata,
    })
    return { metadata, bundle }
  } catch (error) {
    return {
      metadata: {
        mode: 'runtime_fallback',
        fallbackUsed: true,
        fallbackReason: `Compiled read path failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        freshnessPolicy: COMPILED_FRESHNESS_POLICY,
        assets: [
          assetUsage('context_pack', candidates.contextPack[0] ?? '', null, null, 0, 'missing', false),
          assetUsage('dossier', candidates.dossier[0] ?? '', null, null, 0, 'missing', false),
          assetUsage('what_changed', candidates.whatChanged[0] ?? '', null, null, 0, 'missing', false),
          assetUsage('decision_log', candidates.decisionLog[0] ?? '', null, null, 0, 'missing', false),
        ],
      },
      bundle: null,
    }
  }
}
