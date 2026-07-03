import type { Env } from '../types/env'
import type {
  CanonicalSearchInput,
  CanonicalSearchResult,
} from '../types/canonical-memory-query'
import { clampCanonicalLimit } from './canonical-memory-read-model'
import { getCanonicalMemoryStore } from './canonical-postgres'
import { readCompiledSynthesisView } from './compiled-synthesis-read'
import { slugifyStableSegment } from './compiled-synthesis-utils'
import { applyRetrievalBoosts, embedTexts, toRetrievalItem } from './retrieval-support'

export async function searchCanonicalLexicalMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const rows = await getCanonicalMemoryStore(env).searchChunksLexical(
    tenantId, input.query, input.scope ?? null, Math.max(limit * 3, 15),
  )
  const items = applyRetrievalBoosts(
    rows.map((row) => toRetrievalItem(row, 'lexical', input.query)),
    { query: input.query, scope: input.scope ?? null },
  ).slice(0, limit)
  return { query: input.query, mode: 'lexical', status: 'ok', items }
}

/**
 * Semantic retrieval over canonical Postgres pgvector — the Phase 2 hard
 * cutover replacement for Hindsight recall. Degrades to lexical (status
 * 'partial') when embeddings or pgvector are unavailable.
 */
export async function searchCanonicalSemanticMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const store = getCanonicalMemoryStore(env)
  const embeddings = await embedTexts(env, [input.query])
  if (embeddings?.[0] && (await store.vectorSearchAvailable())) {
    const rows = await store.searchChunksSemantic(
      tenantId, embeddings[0], input.scope ?? null, Math.max(limit * 3, 15),
    )
    const items = applyRetrievalBoosts(
      rows.filter((row) => (row.score ?? 0) > 0.3).map((row) => toRetrievalItem(row, 'semantic', input.query)),
      { query: input.query, scope: input.scope ?? null },
    ).slice(0, limit)
    return { query: input.query, mode: 'semantic', status: 'ok', items }
  }
  const fallback = await searchCanonicalLexicalMemory(input, env, tenantId)
  return { ...fallback, mode: 'semantic', status: fallback.items.length > 0 ? 'partial' : 'unavailable' }
}

const TEMPORAL_WINDOWS: Array<{ pattern: RegExp; ms: number }> = [
  { pattern: /\btoday\b/i, ms: 24 * 60 * 60 * 1000 },
  { pattern: /\byesterday\b/i, ms: 2 * 24 * 60 * 60 * 1000 },
  { pattern: /\b(?:last|past|this) week\b/i, ms: 7 * 24 * 60 * 60 * 1000 },
  { pattern: /\b(?:last|past|this) month\b/i, ms: 31 * 24 * 60 * 60 * 1000 },
  { pattern: /\b(?:last|past) (\d+) days?\b/i, ms: 0 },
]

export function resolveTemporalWindow(query: string, now: number): { fromMs: number; toMs: number } {
  for (const window of TEMPORAL_WINDOWS) {
    const match = query.match(window.pattern)
    if (!match) continue
    const ms = window.ms || Number(match[1] ?? 7) * 24 * 60 * 60 * 1000
    return { fromMs: now - ms, toMs: now }
  }
  return { fromMs: now - 7 * 24 * 60 * 60 * 1000, toMs: now }
}

export async function searchCanonicalTemporalMemory(
  input: CanonicalSearchInput & { fromMs?: number | null; toMs?: number | null },
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 10, 20)
  const now = Date.now()
  const window = input.fromMs != null && input.toMs != null
    ? { fromMs: input.fromMs, toMs: input.toMs }
    : resolveTemporalWindow(input.query, now)
  const rows = await getCanonicalMemoryStore(env).listCapturesBetween(
    tenantId, window.fromMs, window.toMs, input.scope ?? null, limit,
  )
  return {
    query: input.query,
    mode: 'temporal',
    status: 'ok',
    items: rows.map((row) => toRetrievalItem(row, 'temporal', input.query)),
  }
}

function compiledStableKeys(subject: string): string[] {
  const slug = slugifyStableSegment(subject)
  return [...new Set([
    `context-pack:chief-of-staff:${slug}`,
    `context-pack:project:${slug}`,
    `context-pack:person:${slug}`,
    `dossier:project:${slug}`,
    `dossier:person:${slug}`,
    `what-changed:project:${slug}`,
    `what-changed:${slug}`,
  ])]
}

export async function searchCanonicalCompiledMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 3, 5)
  const items: CanonicalSearchResult['items'] = []
  for (const stableKey of compiledStableKeys(input.query)) {
    if (items.length >= limit) break
    try {
      const view = await readCompiledSynthesisView(tenantId, stableKey, env)
      if (!view) continue
      const document = view.document as { id?: string; title?: string | null; family?: string; compiledAt?: number | null }
      items.push({
        captureId: null,
        documentId: document.id ?? null,
        title: document.title ?? stableKey,
        scope: input.scope ?? 'projects',
        sourceSystem: 'compiled',
        sourceRef: stableKey,
        preview: `Compiled ${document.family ?? 'view'} for ${input.query} (${stableKey})`,
        capturedAt: document.compiledAt ?? null,
        mode: 'compiled',
        trustState: 'evidence',
        citation: {
          captureId: null,
          documentId: document.id ?? null,
          chunkId: null,
          sourceSystem: 'compiled',
          sourceRef: stableKey,
          capturedAt: document.compiledAt ?? null,
          trustState: 'evidence',
          usePolicy: 'can_use_as_evidence',
          memoryClass: 'compiled_view',
          authorKind: 'system',
        },
      })
    } catch {
      // A missing compiled view is not an error — compiled pages are optional projections.
    }
  }
  return { query: input.query, mode: 'compiled', status: 'ok', items }
}
