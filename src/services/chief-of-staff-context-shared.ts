import type { CanonicalSearchResult, MemoryQueryMode } from '../types/canonical-memory-query'
import type {
  AgentContextBundle,
  ContextBundleIntent,
  ContextEvidenceBlock,
  ContextGap,
  ContextSourceRef,
} from '../types/chief-of-staff-context'

export type QueryPlan = { query: string; mode?: MemoryQueryMode }
export type AssembledContextCore = Omit<AgentContextBundle, 'compiled'>

export const POLICY: Record<ContextBundleIntent, (target: string) => QueryPlan[]> = {
  person: (target) => [{ query: `Brief me on ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `How has my relationship with ${target} changed over time?`, mode: 'graph' }, { query: target, mode: 'raw' }],
  project: (target) => [{ query: `Overview of ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `Timeline for ${target}`, mode: 'graph' }, { query: target, mode: 'raw' }],
  scope: (target) => [{ query: `What should I know about ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `Timeline for ${target}`, mode: 'graph' }, { query: target, mode: 'raw' }],
  meeting_prep: (target) => [{ query: `Prepare context for ${target}` }, { query: `What do I know about ${target}?`, mode: 'semantic' }, { query: `How has my relationship with ${target} changed over time?`, mode: 'graph' }, { query: target, mode: 'raw' }],
}

export const uniq = (values: Array<string | null | undefined>, limit: number) => [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, limit)
export const sourceText = (source: ContextSourceRef) => source.title ? `${source.title}: ${source.preview}` : source.preview
export const timelineText = (source: ContextSourceRef) => `${source.capturedAt ? new Date(source.capturedAt).toISOString().slice(0, 10) : 'unknown'}: ${source.preview}`

export function toSource(mode: MemoryQueryMode, result: CanonicalSearchResult): ContextSourceRef[] {
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

export function dedupeSources(sources: ContextSourceRef[]): ContextSourceRef[] {
  return sources.filter((item, index, all) => all.findIndex((candidate) => `${candidate.mode}:${candidate.captureId}:${candidate.documentId}:${candidate.projectionRef}` === `${item.mode}:${item.captureId}:${item.documentId}:${item.projectionRef}`) === index)
}

export function gapsFor(intent: ContextBundleIntent, evidence: ContextEvidenceBlock[]): ContextGap[] {
  const gaps: ContextGap[] = []
  const add = (kind: ContextGap['kind'], mode: MemoryQueryMode | null, message: string) => gaps.push({ kind, mode, message })
  for (const block of evidence) {
    if (block.status === 'unavailable') add('uncertain', block.mode, `${block.mode} retrieval was unavailable while assembling this bundle.`)
    if (!block.items.length && block.mode !== 'composed') add('missing', block.mode, `No ${block.mode} evidence was found for ${block.query}.`)
  }
  if (!evidence.some((block) => block.mode === 'graph' && block.items.length) && (intent === 'person' || intent === 'project')) add('missing', 'graph', `Relationship or timeline history for ${intent} context is sparse.`)
  return gaps
}

export function buildSummary(target: string, intent: ContextBundleIntent, highlights: string[], relationships: string[], gaps: ContextGap[]): string {
  const lead = highlights[0] ?? `Context for ${target} is sparse.`
  const relation = relationships[0] ? ` ${relationships[0]}.` : ''
  const gap = gaps[0] ? ` ${gaps[0].message}` : ''
  return `${intent.replace(/_/g, ' ')} context for ${target}: ${lead}.${relation}${gap}`.replace(/\.\./g, '.')
}

export function buildConfidence(evidence: ContextEvidenceBlock[], gaps: ContextGap[]): AgentContextBundle['confidence'] {
  const covered = new Set(evidence.filter((block) => block.items.length).map((block) => block.mode))
  const level = covered.has('raw') && covered.has('semantic') && covered.has('graph') ? 'high' : covered.size >= 2 ? 'medium' : 'low'
  return { level: gaps.some((gap) => gap.kind === 'uncertain') && level === 'high' ? 'medium' : level, rationale: `${covered.size} retrieval mode(s) returned grounded evidence; ${gaps.length} gap signal(s) were preserved.` }
}
