import type { Env } from '../types/env'
import type {
  CanonicalBrokerBranchStatus,
  CanonicalBrokerBranchTrace,
  CanonicalBrokerOverlap,
} from '../types/canonical-memory-broker'
import type {
  CanonicalMemoryListItem,
  CanonicalSearchInput,
  CanonicalSearchResult,
  MemoryQueryMode,
} from '../types/canonical-memory-query'
import { executeCanonicalMemoryMode } from './canonical-memory-dispatch'
import { type CanonicalMemoryReadOptions } from './canonical-memory-read-model'

const SHADOW_TIMEOUT_MS = 1500
const SEMANTIC_SHADOW_EXTRACTORS = [
  /\bwhat do i know about\s+(?<focus>.+?)(?:[?.!]|$)/i,
  /\btell me about\s+(?<focus>.+?)(?:[?.!]|$)/i,
  /\bremember\s+(?<focus>.+?)(?:[?.!]|$)/i,
  /\brecall\s+(?<focus>.+?)(?:[?.!]|$)/i,
]

export function summaryOf(items: CanonicalMemoryListItem[]): string | null {
  const previews = items.map((item) => item.recallText ?? item.preview).filter((value) => value?.trim()).slice(0, 2)
  return previews.length ? previews.join(' | ').slice(0, 280) : null
}

function projectionKindOf(items: CanonicalMemoryListItem[]): CanonicalBrokerBranchTrace['projectionKind'] {
  const kinds = [...new Set(items.map((item) => item.attribution?.projectionKind ?? item.provenance?.projectionKind ?? null).filter(Boolean))]
  if (!kinds.length) return items.length ? 'canonical' : null
  return kinds.length > 1 ? 'mixed' : kinds[0] as CanonicalBrokerBranchTrace['projectionKind']
}

function projectionRefOf(items: CanonicalMemoryListItem[]): string | null {
  const top = items[0]
  return top?.attribution?.projectionRef ?? top?.provenance?.graphRef ?? top?.provenance?.targetRef ?? top?.provenance?.projectionResultId ?? top?.provenance?.projectionJobId ?? null
}

function captureIdOf(items: CanonicalMemoryListItem[]): string | null {
  return items[0]?.captureId ?? items[0]?.provenance?.captureId ?? null
}

export function statusOf(result: CanonicalSearchResult): CanonicalBrokerBranchStatus {
  if (result.status === 'unavailable') return 'unavailable'
  if (!result.items.length) return 'empty'
  return result.status === 'partial' ? 'partial' : 'ok'
}

export function traceOf(
  mode: MemoryQueryMode | null,
  latencyMs: number | null,
  result: CanonicalSearchResult | null,
  errorMessage: string | null = null,
  overrideStatus?: CanonicalBrokerBranchStatus,
): CanonicalBrokerBranchTrace {
  return {
    mode,
    status: overrideStatus ?? (result ? statusOf(result) : 'error'),
    latencyMs,
    itemCount: result?.items.length ?? 0,
    summary: result ? summaryOf(result.items) : null,
    projectionKind: result ? projectionKindOf(result.items) : null,
    projectionRef: result ? projectionRefOf(result.items) : null,
    captureId: result ? captureIdOf(result.items) : null,
    errorMessage,
  }
}

export function overlapOf(primary: CanonicalSearchResult, shadow: CanonicalSearchResult | null): CanonicalBrokerOverlap {
  if (!shadow?.items.length || !primary.items.length) return 'unknown'
  const primaryKeys = new Set(primary.items.map((item) => `${item.captureId ?? ''}:${item.documentId ?? ''}:${item.preview}`))
  const shared = shadow.items.filter((item) => primaryKeys.has(`${item.captureId ?? ''}:${item.documentId ?? ''}:${item.preview}`)).length
  if (!shared) return 'distinct'
  return shared === primary.items.length && shared === shadow.items.length ? 'same' : 'partial'
}

export function shadowModeFor(primaryMode: MemoryQueryMode): MemoryQueryMode | null {
  if (primaryMode === 'semantic') return 'graph'
  if (primaryMode === 'graph') return 'semantic'
  return null
}

export function shadowQueryOf(query: string, primaryMode: MemoryQueryMode, dispatchQuery: string): string {
  if (primaryMode !== 'semantic') return dispatchQuery
  for (const extractor of SEMANTIC_SHADOW_EXTRACTORS) {
    const focus = query.match(extractor)?.groups?.focus?.trim()
    if (focus) return focus.replace(/[?.!]+$/, '')
  }
  return dispatchQuery
}

export async function runShadowWithTimeout(
  input: CanonicalSearchInput & { mode: MemoryQueryMode },
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions,
): Promise<{ result: CanonicalSearchResult | null; latencyMs: number | null; status: CanonicalBrokerBranchStatus; errorMessage: string | null }> {
  const startedAt = Date.now()
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const timeoutPromise = new Promise<CanonicalSearchResult>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('shadow timeout')), SHADOW_TIMEOUT_MS)
    })
    const result = await Promise.race([
      executeCanonicalMemoryMode(input, env, tenantId, options),
      timeoutPromise,
    ])
    return { result, latencyMs: Date.now() - startedAt, status: statusOf(result), errorMessage: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      result: null,
      latencyMs: Date.now() - startedAt,
      status: message === 'shadow timeout' ? 'timeout' : 'error',
      errorMessage: message,
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
