import type { Env } from '../types/env'
import type {
  CanonicalMemoryListItem,
  CanonicalSearchInput,
  CanonicalSearchResult,
} from '../types/canonical-memory-query'
import type { HindsightRecallRequest, HindsightRecallResponse } from '../types/hindsight'
import { buildCanonicalPreview, clampCanonicalLimit } from './canonical-memory-read-model'
import { buildHindsightTags, recallMemory } from './hindsight'
import { extractSemanticLookup, resolveCanonicalSemanticLinkback } from './canonical-semantic-linkback'

type SemanticProjectionStatus = 'accepted' | 'queued' | 'completed' | 'failed' | 'unknown'
type SemanticResultStatus = 'queued' | 'completed' | 'failed' | 'missing'

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metadataOf(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.metadata && typeof raw.metadata === 'object'
    ? raw.metadata as Record<string, unknown>
    : {}
}

function normalizeRecallResults(response: HindsightRecallResponse): Record<string, unknown>[] {
  return [...(response.results ?? []), ...(response.items ?? []), ...(response.memories ?? [])]
}

function readRecallText(raw: Record<string, unknown>): string {
  return asString(raw.text)
    ?? asString(raw.content)
    ?? asString(raw.content_preview)
    ?? asString(raw.summary)
    ?? ''
}

function readRecallScore(raw: Record<string, unknown>): number | null {
  return asNumber(raw.score) ?? asNumber(raw.relevance) ?? asNumber(raw.confidence)
}

function readRecallScope(raw: Record<string, unknown>, fallback: string | null): string | null {
  const metadata = metadataOf(raw)
  return asString(metadata.domain) ?? fallback
}

function readCapturedAt(raw: Record<string, unknown>): number | null {
  const metadata = metadataOf(raw)
  const occurredAt = metadata.occurred_at_ms
  return typeof occurredAt === 'string' && /^\d+$/.test(occurredAt) ? Number(occurredAt) : null
}

function toSemanticItem(args: {
  raw: Record<string, unknown>
  query: string
  scope: string | null
  linkback: Awaited<ReturnType<typeof resolveCanonicalSemanticLinkback>>
}): CanonicalMemoryListItem {
  const text = readRecallText(args.raw)
  const lookup = extractSemanticLookup(args.raw)
  const ready = Boolean(
    args.linkback &&
    args.linkback.projectionStatus === 'completed' &&
    args.linkback.resultStatus === 'completed',
  )
  return {
    captureId: args.linkback?.captureId ?? null,
    documentId: args.linkback?.documentId ?? null,
    title: args.linkback?.title ?? null,
    scope: args.linkback?.scope ?? readRecallScope(args.raw, args.scope),
    sourceSystem: args.linkback?.sourceSystem ?? lookup.sourceSystem,
    sourceRef: args.linkback?.sourceRef ?? null,
    preview: buildCanonicalPreview(text, args.query),
    capturedAt: args.linkback?.capturedAt ?? readCapturedAt(args.raw),
    score: readRecallScore(args.raw),
    mode: 'semantic',
    recallText: text,
    provenance: {
      projectionKind: 'hindsight',
      captureId: args.linkback?.captureId ?? null,
      documentId: args.linkback?.documentId ?? null,
      canonicalOperationId: args.linkback?.operationId ?? null,
      projectionJobId: args.linkback?.projectionJobId ?? null,
      projectionResultId: args.linkback?.projectionResultId ?? null,
      targetRef: args.linkback?.targetRef ?? lookup.targetRef,
      sourceSystem: args.linkback?.sourceSystem ?? lookup.sourceSystem,
    },
    semanticStatus: {
      projectionKind: 'hindsight',
      projectionStatus: (args.linkback?.projectionStatus as SemanticProjectionStatus) ?? 'unknown',
      resultStatus: (args.linkback?.resultStatus as SemanticResultStatus) ?? 'missing',
      ready,
    },
  }
}

export async function searchCanonicalSemanticMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  try {
    const response = await recallMemory(tenantId, {
      query: input.query,
      budget: 'mid',
      max_tokens: Math.max(limit * 512, 1024),
      query_timestamp: new Date().toISOString(),
      tags: buildHindsightTags(tenantId, input.scope ?? undefined),
      tags_match: 'all_strict',
    } as HindsightRecallRequest, env)
    const items = await Promise.all(normalizeRecallResults(response).slice(0, limit).map(async raw => {
      const linkback = await resolveCanonicalSemanticLinkback(raw, env, tenantId)
      return toSemanticItem({
        raw,
        query: input.query,
        scope: input.scope ?? null,
        linkback,
      })
    }))
    const status = items.some(item => !item.semanticStatus?.ready) ? 'partial' : 'ok'
    return { query: input.query, mode: 'semantic', status, items }
  } catch (error) {
    console.warn('CANONICAL_SEMANTIC_RECALL_UNAVAILABLE', {
      tenantId,
      query: input.query,
      error: error instanceof Error ? error.message : String(error),
    })
    return { query: input.query, mode: 'semantic', status: 'unavailable', items: [] }
  }
}
