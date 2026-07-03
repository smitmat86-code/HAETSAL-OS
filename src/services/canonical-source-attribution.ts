import type {
  CanonicalMemoryListItem,
  CanonicalSearchResult,
  CanonicalSourceAttribution,
  CanonicalMemoryRouteDecision,
  MemoryQueryMode,
} from '../types/canonical-memory-query'
import { parseBrainMemoryRolloutAttribution } from './external-client-memory'
import { parseGoogleSourceReadAttribution } from './google-source-read-contract'

// Engine projections retired in mission Phase 3 — kind comes from provenance only.
function projectionKindOf(item: CanonicalMemoryListItem): string | null {
  return item.provenance?.projectionKind ?? null
}

function projectionRefOf(item: CanonicalMemoryListItem): string | null {
  return item.provenance?.graphRef
    ?? item.provenance?.targetRef
    ?? item.provenance?.projectionResultId
    ?? item.provenance?.projectionJobId
    ?? null
}

export function buildCanonicalSourceAttribution(
  item: CanonicalMemoryListItem,
  mode: MemoryQueryMode,
): CanonicalSourceAttribution {
  return {
    mode,
    sourceSystem: item.provenance?.sourceSystem ?? item.sourceSystem,
    captureId: item.provenance?.captureId ?? item.captureId,
    documentId: item.provenance?.documentId ?? item.documentId,
    canonicalOperationId: item.provenance?.canonicalOperationId ?? null,
    projectionKind: projectionKindOf(item),
    projectionRef: projectionRefOf(item),
    targetRef: item.provenance?.targetRef ?? null,
    graphRef: item.provenance?.graphRef ?? null,
  }
}

export function applyCanonicalRoute(
  result: CanonicalSearchResult,
  route: CanonicalMemoryRouteDecision,
): CanonicalSearchResult {
  return {
    ...result,
    mode: route.mode,
    route,
    items: result.items.map((item) => ({
      ...item,
      mode: route.mode,
      brainMemory: item.brainMemory ?? parseBrainMemoryRolloutAttribution({
        sourceSystem: item.sourceSystem,
        sourceRef: item.sourceRef,
      }),
      googleSource: item.googleSource ?? parseGoogleSourceReadAttribution({
        sourceSystem: item.sourceSystem,
        sourceRef: item.sourceRef,
      }),
      attribution: buildCanonicalSourceAttribution(item, route.mode),
    })),
  }
}
