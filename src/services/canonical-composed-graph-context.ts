import type { Env } from '../types/env'
import type { CanonicalMemoryListItem, CanonicalSearchInput, CanonicalSearchResult } from '../types/canonical-memory-query'
import { clampCanonicalLimit } from './canonical-memory-read-model'
import { getCanonicalEntityTimeline } from './canonical-graph-query'

function buildGraphPreview(item: Awaited<ReturnType<typeof getCanonicalEntityTimeline>>['items'][number]): string {
  return `${item.entity.label} ${item.relation.replace(/_/g, ' ')} ${item.relatedEntity.label}` +
    (item.title ? ` in ${item.title}` : '')
}

function toGraphListItem(item: Awaited<ReturnType<typeof getCanonicalEntityTimeline>>['items'][number]): CanonicalMemoryListItem {
  return {
    captureId: item.provenance.captureId ?? null,
    documentId: item.provenance.documentId ?? null,
    title: item.title,
    scope: item.scope,
    sourceSystem: item.sourceSystem,
    sourceRef: item.sourceRef,
    preview: buildGraphPreview(item),
    capturedAt: item.capturedAt,
    mode: 'graph',
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
  return { query: input.query, mode: 'graph', status: 'ok', items: timeline.items.slice(0, limit).map(toGraphListItem) }
}
