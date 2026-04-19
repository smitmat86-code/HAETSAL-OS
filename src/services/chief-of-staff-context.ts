import type { Env } from '../types/env'
import type { CanonicalSearchResult, MemoryQueryMode } from '../types/canonical-memory-query'
import type { AgentContextBundle, ContextBundleIntent, ContextEvidenceBlock, ContextGap, ContextSourceRef, PrepareContextForAgentInput } from '../types/chief-of-staff-context'
import { clampCanonicalLimit, type CanonicalMemoryReadOptions } from './canonical-memory-read-model'
import { searchCanonicalMemory } from './canonical-memory-query'

type QueryPlan = { query: string; mode?: MemoryQueryMode }

const OPEN_LOOP_RE = /\b(follow[- ]?up|open question|needs?|owner|todo|unresolved)\b/i
const RISK_RE = /\b(risk|blocker|blocked|critical path|uncertain|delay)\b/i
const POLICY: Record<ContextBundleIntent, (target: string) => QueryPlan[]> = {
  person: (target) => [{ query: `Brief me on ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `How has my relationship with ${target} changed over time?`, mode: 'graph' }, { query: target, mode: 'raw' }],
  project: (target) => [{ query: `Overview of ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `Timeline for ${target}`, mode: 'graph' }, { query: target, mode: 'raw' }],
  scope: (target) => [{ query: `What should I know about ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `Timeline for ${target}`, mode: 'graph' }, { query: target, mode: 'raw' }],
  meeting_prep: (target) => [{ query: `Prepare context for ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `How has my relationship with ${target} changed over time?`, mode: 'graph' }, { query: target, mode: 'raw' }],
}

const uniq = (values: Array<string | null | undefined>, limit: number) => [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, limit)
const sourceText = (source: ContextSourceRef) => source.title ? `${source.title}: ${source.preview}` : source.preview
const timelineText = (source: ContextSourceRef) => `${source.capturedAt ? new Date(source.capturedAt).toISOString().slice(0, 10) : 'unknown'}: ${source.preview}`

function toSource(mode: MemoryQueryMode, result: CanonicalSearchResult): ContextSourceRef[] {
  return result.items.map((item) => ({
    mode,
    title: item.title,
    preview: item.recallText ?? item.preview,
    captureId: item.captureId,
    documentId: item.documentId,
    sourceSystem: item.sourceSystem,
    sourceRef: item.sourceRef,
    capturedAt: item.capturedAt,
    projectionRef: item.attribution?.projectionRef ?? null,
    targetRef: item.attribution?.targetRef ?? null,
    graphRef: item.attribution?.graphRef ?? null,
  }))
}

function gapsFor(intent: ContextBundleIntent, evidence: ContextEvidenceBlock[]): ContextGap[] {
  const gaps: ContextGap[] = []
  const add = (kind: ContextGap['kind'], mode: MemoryQueryMode | null, message: string) => gaps.push({ kind, mode, message })
  for (const block of evidence) {
    if (block.status === 'unavailable') add('uncertain', block.mode, `${block.mode} retrieval was unavailable while assembling this bundle.`)
    if (!block.items.length && block.mode !== 'composed') add('missing', block.mode, `No ${block.mode} evidence was found for ${block.query}.`)
  }
  if (!evidence.some((block) => block.mode === 'graph' && block.items.length) && (intent === 'person' || intent === 'project')) add('missing', 'graph', `Relationship or timeline history for ${intent} context is sparse.`)
  return gaps
}

function buildSummary(target: string, intent: ContextBundleIntent, highlights: string[], relationships: string[], gaps: ContextGap[]): string {
  const lead = highlights[0] ?? `Context for ${target} is sparse.`
  const relation = relationships[0] ? ` ${relationships[0]}.` : ''
  const gap = gaps[0] ? ` ${gaps[0].message}` : ''
  return `${intent.replace(/_/g, ' ')} context for ${target}: ${lead}.${relation}${gap}`.replace(/\.\./g, '.')
}

function buildConfidence(evidence: ContextEvidenceBlock[], gaps: ContextGap[]): AgentContextBundle['confidence'] {
  const covered = new Set(evidence.filter((block) => block.items.length).map((block) => block.mode))
  const level = covered.has('raw') && covered.has('semantic') && covered.has('graph') ? 'high' : covered.size >= 2 ? 'medium' : 'low'
  return { level: gaps.some((gap) => gap.kind === 'uncertain') && level === 'high' ? 'medium' : level, rationale: `${covered.size} retrieval mode(s) returned grounded evidence; ${gaps.length} gap signal(s) were preserved.` }
}

export async function prepareContextForAgent(
  input: PrepareContextForAgentInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<AgentContextBundle> {
  const limit = clampCanonicalLimit(input.limit, 4, 6)
  const results = await Promise.all(POLICY[input.intent](input.target).map(async (plan) => {
    const result = await searchCanonicalMemory({ tenantId, query: plan.query, scope: input.scope ?? null, limit, mode: plan.mode }, env, tenantId, options)
    return { result, query: plan.query }
  }))
  const evidence = results.map(({ result, query }) => ({ mode: result.mode, query, status: result.status, routeReason: result.route?.reason ?? null, items: toSource(result.mode, result) satisfies ContextSourceRef[] }))
  const sources = evidence.flatMap((block) => block.items).filter((item, index, all) => all.findIndex((candidate) => `${candidate.mode}:${candidate.captureId}:${candidate.documentId}:${candidate.projectionRef}` === `${item.mode}:${item.captureId}:${item.documentId}:${item.projectionRef}`) === index)
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
