import type { Env } from '../types/env'
import type {
  CanonicalDocumentInput,
  CanonicalDocumentResult,
  CanonicalMemoryListItem,
  CanonicalRecentInput,
  CanonicalRecentResult,
  CanonicalSearchInput,
  CanonicalSearchResult,
} from '../types/canonical-memory-query'
import {
  buildCanonicalPreview,
  clampCanonicalLimit,
  readCanonicalDocumentBody,
  type CanonicalDocumentRow,
  type CanonicalListRow,
  type CanonicalMemoryReadOptions,
} from './canonical-memory-read-model'

async function listCanonicalRows(
  env: Env,
  tenantId: string,
  scope: string | null,
  limit: number,
): Promise<CanonicalListRow[]> {
  const rows = await env.D1_US.prepare(
    `SELECT c.id AS capture_id, d.id AS document_id, d.title, c.scope, c.source_system,
            c.source_ref, c.captured_at, d.body_r2_key
     FROM canonical_documents d
     INNER JOIN canonical_captures c ON c.id = d.capture_id
     WHERE d.tenant_id = ?
       AND (? IS NULL OR c.scope = ?)
     ORDER BY c.captured_at DESC
     LIMIT ?`,
  ).bind(tenantId, scope, scope, limit).all<CanonicalListRow>()
  return rows.results ?? []
}

function toMemoryListItem(
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
    ...(score ? { score } : {}),
  }
}

function scoreCanonicalRow(query: string, row: CanonicalListRow, body: string | null): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  const haystacks = [row.title, row.source_ref, row.scope, body ?? ''].map(value => (value ?? '').toLowerCase())
  if (haystacks.some(value => value === needle)) return 5
  if (haystacks.some(value => value.includes(needle))) return 3
  const terms = needle.split(/\s+/).filter(Boolean)
  const matchedTerms = terms.filter(term => haystacks.some(value => value.includes(term))).length
  return matchedTerms > 0 ? matchedTerms : 0
}

export async function searchCanonicalMemory(
  input: CanonicalSearchInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalSearchResult> {
  const limit = clampCanonicalLimit(input.limit, 5, 10)
  const rows = await listCanonicalRows(env, tenantId, input.scope ?? null, Math.max(limit * 4, 20))
  const items = await Promise.all(rows.map(async row => {
    const body = options.tmk ? await readCanonicalDocumentBody(env, row.body_r2_key, options.tmk) : null
    const score = scoreCanonicalRow(input.query, row, body)
    return score > 0 ? toMemoryListItem(row, body, score) : null
  }))
  return {
    query: input.query,
    items: items.filter(Boolean)
      .sort((left, right) => (right!.score ?? 0) - (left!.score ?? 0) || right!.capturedAt - left!.capturedAt)
      .slice(0, limit) as CanonicalMemoryListItem[],
  }
}

export async function listRecentCanonicalMemories(
  input: CanonicalRecentInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalRecentResult> {
  const limit = clampCanonicalLimit(input.limit, 10, 20)
  const rows = await listCanonicalRows(env, tenantId, input.scope ?? null, limit)
  const items = await Promise.all(rows.map(async row => {
    const body = options.tmk ? await readCanonicalDocumentBody(env, row.body_r2_key, options.tmk) : null
    return toMemoryListItem(row, body)
  }))
  return { items }
}

export async function getCanonicalDocument(
  input: CanonicalDocumentInput,
  env: Env,
  tenantId: string,
  options: CanonicalMemoryReadOptions = {},
): Promise<CanonicalDocumentResult> {
  if (!options.tmk) throw new Error('Active session key required for canonical document reads')
  const row = await env.D1_US.prepare(
    `SELECT c.id AS capture_id, d.id AS document_id, d.title, c.scope, c.source_system, c.source_ref,
            c.captured_at, d.body_r2_key, d.chunk_count, d.created_at AS document_created_at,
            a.id AS artifact_id, a.filename, a.media_type, a.byte_length
     FROM canonical_documents d
     INNER JOIN canonical_captures c ON c.id = d.capture_id
     LEFT JOIN canonical_artifacts a ON a.id = d.artifact_id
     WHERE d.tenant_id = ? AND d.id = ?`,
  ).bind(tenantId, input.documentId).first<CanonicalDocumentRow>()
  if (!row) throw new Error(`Canonical document not found: ${input.documentId}`)
  return {
    captureId: row.capture_id,
    documentId: row.document_id,
    title: row.title,
    scope: row.scope,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    body: await readCanonicalDocumentBody(env, row.body_r2_key, options.tmk),
    chunkCount: row.chunk_count,
    capturedAt: row.captured_at,
    createdAt: row.document_created_at,
    artifact: row.artifact_id
      ? {
        artifactId: row.artifact_id,
        filename: row.filename,
        mediaType: row.media_type,
        byteLength: row.byte_length,
      }
      : null,
  }
}
