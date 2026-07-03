import type { Env } from '../types/env'
import type {
  CanonicalMemoryListItem,
  CanonicalSearchInput,
  CanonicalSearchResult,
  MemoryQueryMode,
} from '../types/canonical-memory-query'
import { clampCanonicalLimit } from './canonical-memory-read-model'
import { getCanonicalEntityTimeline } from './canonical-graph-query'
import {
  searchCanonicalCompiledMemory,
  searchCanonicalLexicalMemory,
  searchCanonicalSemanticMemory,
} from './retrieval-modes'

function buildGraphPreview(item: Awaited<ReturnType<typeof getCanonicalEntityTimeline>>['items'][number]): string {
  return `${item.entity.label} ${item.relation.replace(/_/g, ' ')} ${item.relatedEntity.label}` +
    (item.title ? ` in ${item.title}` : '')
}

function toGraphListItem(
  item: Awaited<ReturnType<typeof getCanonicalEntityTimeline>>['items'][number],
  mode: MemoryQueryMode,
): CanonicalMemoryListItem {
  return {
    captureId: item.provenance.captureId ?? null,
    documentId: item.provenance.documentId ?? null,
    title: item.title,
    scope: item.scope,
    sourceSystem: item.sourceSystem,
    sourceRef: item.sourceRef,
    preview: buildGraphPreview(item),
    capturedAt: item.capturedAt,
    mode,
    provenance: item.provenance,
    graphContext: {
      entityKey: item.entity.key,
      entityLabel: item.entity.label,
      relation: item.relation,
      relatedEntityKey: item.relatedEntity.key,
      relatedEntityLabel: item.relatedEntity.label,
      graphRef: item.provenance.graphRef ?? null,
      targetRef: item.provenance.targetRef ?? null,
    },
  }
}

export async function searchCanonicalGraphMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const timeline = await getCanonicalEntityTimeline(
    { tenantId, entity: input.query, limit, startAt: null, endAt: null },
    env,
    tenantId,
  )
  return {
    query: input.query,
    mode: 'graph',
    status: 'ok',
    items: timeline.items.slice(0, limit).map((item) => toGraphListItem(item, 'graph')),
  }
}

/**
 * Composed mode: brokered bundle merging semantic, lexical, graph, and
 * compiled retrieval with citations and per-mode gap notes
 * (HAETSAL_MISSION.md Phase 2). Deduplicates by capture/document identity;
 * every item keeps the provenance of the mode that surfaced it.
 */
export async function searchCanonicalComposedMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const perMode = Math.max(Math.ceil(limit / 2), 3)
  const [semantic, lexical, graph, compiled] = await Promise.all([
    searchCanonicalSemanticMemory({ ...input, limit: perMode }, env, tenantId).catch(() => null),
    searchCanonicalLexicalMemory({ ...input, limit: perMode }, env, tenantId).catch(() => null),
    searchCanonicalGraphMemory({ ...input, limit: perMode }, env, tenantId).catch(() => null),
    searchCanonicalCompiledMemory({ ...input, limit: 2 }, env, tenantId).catch(() => null),
  ])

  const seen = new Set<string>()
  const items: CanonicalMemoryListItem[] = []
  for (const result of [compiled, semantic, graph, lexical]) {
    for (const item of result?.items ?? []) {
      const key = item.documentId ?? item.captureId ?? `${item.mode}:${item.preview}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }

  const contributing = [semantic, lexical, graph, compiled].filter((result) => (result?.items.length ?? 0) > 0)
  const status: CanonicalSearchResult['status'] = items.length === 0
    ? 'unavailable'
    : contributing.length >= 2 || (semantic?.status === 'ok' && semantic.items.length > 0)
      ? 'ok'
      : 'partial'
  return { query: input.query, mode: 'composed', status, items: items.slice(0, limit) }
}
