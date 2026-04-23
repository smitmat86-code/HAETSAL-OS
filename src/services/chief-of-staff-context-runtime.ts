import type { Env } from '../types/env'
import type {
  PrepareContextForAgentInput,
  ContextSourceRef,
} from '../types/chief-of-staff-context'
import { clampCanonicalLimit, type CanonicalMemoryReadOptions } from './canonical-memory-read-model'
import { searchCanonicalMemory } from './canonical-memory-query'
import {
  POLICY,
  AssembledContextCore,
  buildConfidence,
  buildSummary,
  dedupeSources,
  gapsFor,
  sourceText,
  timelineText,
  toSource,
  uniq,
} from './chief-of-staff-context-shared'

const OPEN_LOOP_RE = /\b(follow[- ]?up|open question|needs?|owner|todo|unresolved)\b/i
const RISK_RE = /\b(risk|blocker|blocked|critical path|uncertain|delay)\b/i

export async function assembleRuntimeContext(
  input: PrepareContextForAgentInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions,
): Promise<AssembledContextCore> {
  const limit = clampCanonicalLimit(input.limit, 4, 6)
  const results = await Promise.all(POLICY[input.intent](input.target).map(async (plan) => {
    const result = await searchCanonicalMemory(
      { tenantId, query: plan.query, scope: input.scope ?? null, limit, mode: plan.mode },
      env,
      tenantId,
      options,
    )
    return { result, query: plan.query }
  }))
  const evidence = results.map(({ result, query }) => ({ mode: result.mode, query, status: result.status, routeReason: result.route?.reason ?? null, items: toSource(result.mode, result) satisfies ContextSourceRef[] }))
  const sources = dedupeSources(evidence.flatMap((block) => block.items))
  const graphSources = evidence.filter((block) => block.mode === 'graph' || block.mode === 'composed').flatMap((block) => block.items)
  const textSources = [...evidence.filter((block) => block.mode === 'semantic' || block.mode === 'composed').flatMap((block) => block.items), ...evidence.filter((block) => block.mode === 'raw').flatMap((block) => block.items)]
  const highlights = uniq(textSources.map(sourceText), 4)
  const recentChanges = uniq([...sources].sort((left, right) => (right.capturedAt ?? 0) - (left.capturedAt ?? 0)).map(sourceText), 4)
  const relationships = uniq(graphSources.map((source) => source.preview), 4)
  const timeline = uniq([...graphSources].sort((left, right) => (right.capturedAt ?? 0) - (left.capturedAt ?? 0)).map(timelineText), 4)
  const openLoops = uniq(textSources.filter((source) => OPEN_LOOP_RE.test(source.preview)).map(sourceText), 3)
  const risks = uniq(textSources.filter((source) => RISK_RE.test(source.preview) || OPEN_LOOP_RE.test(source.preview)).map(sourceText), 3)
  const gaps = gapsFor(input.intent, evidence)

  return {
    agent: input.agent,
    intent: input.intent,
    target: input.target,
    scope: input.scope ?? null,
    summary: buildSummary(input.target, input.intent, highlights, relationships, gaps),
    confidence: buildConfidence(evidence, gaps),
    highlights,
    recentChanges,
    openLoops,
    risks,
    timeline,
    relationships,
    followUpQuestions: uniq([
      !relationships.length ? `What relationship history is still missing for ${input.target}?` : null,
      !openLoops.length ? `What remains unresolved for ${input.target}?` : null,
      evidence.some((block) => block.mode === 'raw' && !block.items.length) ? `What is the most recent source-grounded update for ${input.target}?` : null,
    ], 3),
    gaps,
    sources,
    evidence,
  }
}
