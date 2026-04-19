import type { Env } from '../types/env'
import type {
  CanonicalMemoryListItem,
  CanonicalSearchInput,
  CanonicalSearchResult,
  MemoryQueryMode,
} from '../types/canonical-memory-query'
import { clampCanonicalLimit } from './canonical-memory-read-model'
import { getCanonicalEntityTimeline } from './canonical-graph-query'

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

async function searchGraphBackedContext(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
  mode: 'graph' | 'composed',
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const timeline = await getCanonicalEntityTimeline(
    { tenantId, entity: input.query, limit, startAt: null, endAt: null },
    env,
    tenantId,
  )
  return {
    query: input.query,
    mode,
    status: 'ok',
    items: timeline.items.slice(0, limit).map((item) => toGraphListItem(item, mode)),
  }
}

export async function searchCanonicalGraphMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  return searchGraphBackedContext(input, env, tenantId, 'graph')
}

export async function searchCanonicalComposedMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  return searchGraphBackedContext(input, env, tenantId, 'composed')
}
