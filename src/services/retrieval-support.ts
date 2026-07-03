import type { Env } from '../types/env'
import type {
  CanonicalMemoryListItem,
  CanonicalRetrievalCitation,
  MemoryQueryMode,
} from '../types/canonical-memory-query'
import type { CanonicalRetrievalRow } from './canonical-postgres-schema'
import { buildCanonicalPreview } from './canonical-memory-read-model'
import { MODEL_EMBEDDING } from '../config/models'

export const CANONICAL_EMBEDDING_MODEL = MODEL_EMBEDDING

/**
 * Embed texts through Workers AI via AI Gateway. Law 2 / G4: inputs contain
 * plaintext memory content, so payload logging is disabled (collectLog false).
 * Returns null when embeddings are unavailable — callers degrade gracefully.
 */
export async function embedTexts(env: Env, texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const ai = (env as { AI?: { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> } }).AI
    if (!ai?.run) return null
    const response = await ai.run(
      CANONICAL_EMBEDDING_MODEL,
      { text: texts },
      { gateway: { id: env.AI_GATEWAY_ID, collectLog: false } },
    ) as { data?: number[][] }
    return Array.isArray(response?.data) && response.data.length === texts.length ? response.data : null
  } catch (error) {
    console.warn('CANONICAL_EMBEDDING_UNAVAILABLE', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export function citationOf(row: CanonicalRetrievalRow): CanonicalRetrievalCitation {
  return {
    captureId: row.capture_id,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    capturedAt: row.captured_at,
    trustState: row.trust_state,
    usePolicy: row.use_policy,
    memoryClass: row.memory_class,
    authorKind: row.author_kind,
  }
}

export function toRetrievalItem(
  row: CanonicalRetrievalRow,
  mode: MemoryQueryMode,
  query: string,
): CanonicalMemoryListItem {
  return {
    captureId: row.capture_id,
    documentId: row.document_id,
    title: row.title,
    scope: row.scope,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    preview: buildCanonicalPreview(row.chunk_text ?? row.title ?? row.source_ref ?? row.scope, query),
    capturedAt: row.captured_at,
    score: row.score,
    mode,
    recallText: row.chunk_text ?? null,
    trustState: row.trust_state,
    citation: citationOf(row),
  }
}

const TRUST_WEIGHTS: Record<string, number> = {
  user_confirmed: 1.15,
  trusted_import: 1.1,
  evidence: 1,
  inferred: 0.95,
  stale: 0.8,
  disputed: 0.7,
  superseded: 0.5,
  rejected: 0,
}

/** Source authority: first-party explicit writes outrank bulk ingests (GBrain pattern). */
const SOURCE_AUTHORITY: Record<string, number> = {
  'mcp:memory_write': 1.1,
  mcp_retain: 1.08,
  notes: 1.05,
  obsidian: 1.05,
  sms: 1.02,
  gmail: 1,
  calendar: 1,
  drive: 0.98,
}

const FRESHNESS_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Title/scope/source-authority/freshness/trust-state boosts
 * (HAETSAL_MISSION.md Phase 2). Deterministic and metadata-only.
 */
export function applyRetrievalBoosts(
  items: CanonicalMemoryListItem[],
  args: { query: string; scope?: string | null; now?: number },
): CanonicalMemoryListItem[] {
  const now = args.now ?? Date.now()
  const needle = args.query.trim().toLowerCase()
  return items
    .map((item) => {
      const base = item.score ?? 0.5
      const trust = TRUST_WEIGHTS[item.trustState ?? 'evidence'] ?? 1
      const authority = SOURCE_AUTHORITY[item.sourceSystem ?? ''] ?? 1
      const ageMs = Math.max(0, now - (item.capturedAt ?? now))
      const freshness = 0.7 + 0.3 * Math.pow(0.5, ageMs / FRESHNESS_HALF_LIFE_MS)
      const titleBonus = needle && item.title?.toLowerCase().includes(needle) ? 0.15 : 0
      const scopeBonus = args.scope && item.scope === args.scope ? 0.05 : 0
      return { ...item, score: base * trust * authority * freshness + titleBonus + scopeBonus }
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || (right.capturedAt ?? 0) - (left.capturedAt ?? 0))
}
