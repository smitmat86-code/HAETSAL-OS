import type { Env } from '../types/env'
import type {
  CanonicalMemoryListItem,
  CanonicalSearchInput,
  CanonicalSearchResult,
  MemoryQueryMode,
} from '../types/canonical-memory-query'
import {
  buildCanonicalPreview,
  clampCanonicalLimit,
  readCanonicalDocumentBody,
  type CanonicalListRow,
  type CanonicalMemoryReadOptions,
} from './canonical-memory-read-model'
import { searchCanonicalComposedMemory, searchCanonicalGraphMemory } from './canonical-composed-graph-context'
import {
  searchCanonicalCompiledMemory,
  searchCanonicalLexicalMemory,
  searchCanonicalSemanticMemory,
  searchCanonicalTemporalMemory,
} from './retrieval-modes'
import { parseBrainMemoryRolloutAttribution } from './external-client-memory'
import { parseGoogleSourceReadAttribution } from './google-source-read-contract'
import { getCanonicalMemoryStore } from './canonical-postgres'

export async function listCanonicalRows(
  env: Env,
  tenantId: string,
  scope: string | null,
  limit: number,
): Promise<CanonicalListRow[]> {
  return getCanonicalMemoryStore(env).listRecentDocuments(tenantId, scope, limit)
}

export function toMemoryListItem(
  row: CanonicalListRow,
  body: string | null,
  score?: number,
): CanonicalMemoryListItem {
  return {
    captureId: row.capture_id,
    documentId: row.document_id,
    title: row.title,
    scope: row.scope,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    preview: buildCanonicalPreview(body ?? row.title ?? row.source_ref ?? row.scope),
    capturedAt: row.captured_at,
    mode: 'raw',
    brainMemory: parseBrainMemoryRolloutAttribution({
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
    }),
    googleSource: parseGoogleSourceReadAttribution({
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
    }),
    ...(score !== undefined ? { score } : {}),
  }
}

function scoreCanonicalRow(query: string, row: CanonicalListRow, body: string | null): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  const haystacks = [row.title, row.source_ref, row.scope, body ?? ''].map(
    (value) => (value ?? '').toLowerCase(),
  )
  if (haystacks.some((value) => value === needle)) return 5
  if (haystacks.some((value) => value.includes(needle))) return 3
  const matchedTerms = needle
    .split(/\s+/)
    .filter(Boolean)
    .filter((term) => haystacks.some((value) => value.includes(term))).length
  return matchedTerms > 0 ? matchedTerms : 0
}

export async function searchCanonicalRawMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const rows = await listCanonicalRows(env, tenantId, input.scope ?? null, Math.max(limit * 4, 20))
  const items = await Promise.all(rows.map(async (row) => {
    // A single missing/corrupt R2 body must not break raw search for the
    // tenant — degrade that row to metadata-only scoring.
    const body = options.tmk
      ? await readCanonicalDocumentBody(env, row.body_r2_key, options.tmk).catch(() => null)
      : null
    const score = scoreCanonicalRow(input.query, row, body)
    return score > 0 ? toMemoryListItem(row, body, score) : null
  }))
  return {
    query: input.query,
    mode: 'raw',
    status: 'ok',
    items: items
      .filter(Boolean)
      .sort(
        (left, right) =>
          ((right!.score ?? 0) - (left!.score ?? 0))
          || ((right!.capturedAt ?? 0) - (left!.capturedAt ?? 0)),
      )
      .slice(0, limit) as CanonicalMemoryListItem[],
  }
}

export async function executeCanonicalMemoryMode(
  input: CanonicalSearchInput & { mode: MemoryQueryMode },
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalSearchResult> {
  if (input.mode === 'lexical') return searchCanonicalLexicalMemory(input, env, tenantId)
  if (input.mode === 'semantic') return searchCanonicalSemanticMemory(input, env, tenantId)
  if (input.mode === 'graph') return searchCanonicalGraphMemory(input, env, tenantId)
  if (input.mode === 'temporal') return searchCanonicalTemporalMemory(input, env, tenantId)
  if (input.mode === 'compiled') return searchCanonicalCompiledMemory(input, env, tenantId)
  if (input.mode === 'composed') return searchCanonicalComposedMemory(input, env, tenantId)
  return searchCanonicalRawMemory(input, env, tenantId, options)
}
