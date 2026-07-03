import type {
  CanonicalMemoryRouteDecision,
  MemoryQueryMode,
  MemoryQueryModePreference,
} from '../types/canonical-memory-query'

const RAW_PATTERNS = [
  /\bexactly\b/i,
  /\bverbatim\b/i,
  /\bwhat did i (?:say|write|capture)\b/i,
  /\b(?:document|transcript|note|email|file|source)\b/i,
  /\blast (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
]
const GRAPH_PATTERNS = [
  /\brelationship\b/i,
  /\btimeline\b/i,
  /\bover time\b/i,
  /\bhow has\b/i,
  /\bhistory with\b/i,
  /\btrace\b/i,
]
const COMPOSED_PATTERNS = [
  /\bprepare context\b/i,
  /\bcontext for\b/i,
  /\bbrief me on\b/i,
  /\bwhat should i know about\b/i,
  /\boverview of\b/i,
  /\bget me up to speed\b/i,
]
const SEMANTIC_PATTERNS = [
  /\bwhat do i know about\b/i,
  /\btell me about\b/i,
  /\bremember\b/i,
  /\brecall\b/i,
  /^\s*(?:who|what|where|why|how)\b/i,
]
const TEMPORAL_PATTERNS = [
  /\btoday\b/i,
  /\byesterday\b/i,
  /\b(?:last|past|this) (?:week|month)\b/i,
  /\b(?:last|past) \d+ days?\b/i,
  /\bwhat (?:did i|happened)\b/i,
  /\bsince (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday)\b/i,
  /^\s*when\b/i,
]
const COMPILED_PATTERNS = [
  /\bdossier\b/i,
  /\bcontext pack\b/i,
  /\bcompiled\b/i,
  /\bwhat changed (?:in|on|for)\b/i,
]
const LEXICAL_PATTERNS = [
  /"[^"]+"/,
  /\bcontaining\b/i,
  /\bmentioning\b/i,
  /\bkeyword\b/i,
]
const RAW_EXTRACTORS = [
  /(?:exactly|verbatim).*?\b(?:said|wrote|captured)\b(?:\s+about)?\s+(?<focus>.+)$/i,
  /\babout\s+(?<focus>.+)$/i,
]
const GRAPH_EXTRACTORS = [
  /\brelationship with\s+(?<focus>.+?)(?:\s+(?:changed over time|over time|evolved)|[?.!]|$)/i,
  /\btimeline (?:for|of)\s+(?<focus>.+?)(?:[?.!]|$)/i,
  /\bhow has (?:(?:my|our)\s+relationship with\s+)?(?<focus>.+?)(?:\s+changed over time|\s+evolved|[?.!]|$)/i,
  /\bhistory with\s+(?<focus>.+?)(?:[?.!]|$)/i,
]
const COMPOSED_EXTRACTORS = [
  /\bprepare context for\s+(?<focus>.+?)(?:\s+(?:before|ahead of)|[?.!]|$)/i,
  /\bcontext for\s+(?<focus>.+?)(?:\s+(?:before|ahead of)|[?.!]|$)/i,
  /\bbrief me on\s+(?<focus>.+?)(?:[?.!]|$)/i,
  /\bwhat should i know about\s+(?<focus>.+?)(?:[?.!]|$)/i,
  /\boverview of\s+(?<focus>.+?)(?:[?.!]|$)/i,
]

function cleaned(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[?.!]+$/, '').trim()
}

function extractFocus(query: string, extractors: RegExp[]): string {
  for (const extractor of extractors) {
    const match = query.match(extractor)
    const focus = match?.groups?.focus
    if (focus) return cleaned(focus)
  }
  return cleaned(query)
}

export function normalizeMemoryQueryMode(
  mode?: MemoryQueryModePreference | null,
): MemoryQueryMode | null {
  return mode ?? null
}

export function decideCanonicalMemoryRoute(
  query: string,
  requestedMode?: MemoryQueryModePreference | null,
): CanonicalMemoryRouteDecision {
  const explicitMode = normalizeMemoryQueryMode(requestedMode)
  if (explicitMode) {
    return {
      mode: explicitMode,
      reason: `Caller requested ${explicitMode} mode.`,
      explicit: true,
      dispatchQuery: extractDispatchQuery(query, explicitMode),
    }
  }
  const mode = inferMemoryQueryMode(query)
  return {
    mode,
    reason: inferredReason(mode),
    explicit: false,
    dispatchQuery: extractDispatchQuery(query, mode),
  }
}

function inferMemoryQueryMode(query: string): MemoryQueryMode {
  const text = cleaned(query)
  if (!text) return 'raw'
  if (COMPOSED_PATTERNS.some((pattern) => pattern.test(text))) return 'composed'
  if (COMPILED_PATTERNS.some((pattern) => pattern.test(text))) return 'compiled'
  if (GRAPH_PATTERNS.some((pattern) => pattern.test(text))) return 'graph'
  if (TEMPORAL_PATTERNS.some((pattern) => pattern.test(text))) return 'temporal'
  if (LEXICAL_PATTERNS.some((pattern) => pattern.test(text))) return 'lexical'
  if (RAW_PATTERNS.some((pattern) => pattern.test(text))) return 'raw'
  if (SEMANTIC_PATTERNS.some((pattern) => pattern.test(text))) return 'semantic'
  return 'semantic'
}

function extractDispatchQuery(query: string, mode: MemoryQueryMode): string {
  if (mode === 'graph') return extractFocus(query, GRAPH_EXTRACTORS)
  if (mode === 'composed') return extractFocus(query, COMPOSED_EXTRACTORS)
  if (mode === 'raw') return extractFocus(query, RAW_EXTRACTORS)
  return cleaned(query)
}

function inferredReason(mode: MemoryQueryMode): string {
  if (mode === 'composed') return 'Broader context-building phrasing favored composed retrieval.'
  if (mode === 'compiled') return 'Compiled-view phrasing favored compiled retrieval.'
  if (mode === 'graph') return 'Relationship or timeline phrasing favored graph retrieval.'
  if (mode === 'temporal') return 'Time-window phrasing favored temporal retrieval.'
  if (mode === 'lexical') return 'Quoted or keyword phrasing favored lexical retrieval.'
  if (mode === 'semantic') return 'Concept or fact phrasing favored semantic retrieval.'
  return 'Exact or document-style phrasing favored raw retrieval.'
}
