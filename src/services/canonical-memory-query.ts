import type { Env } from '../types/env'
import type { CanonicalDocumentInput, CanonicalDocumentResult, CanonicalMemoryListItem, CanonicalRecentInput, CanonicalRecentResult, CanonicalSearchInput, CanonicalSearchResult } from '../types/canonical-memory-query'
import { clampCanonicalLimit, readCanonicalDocumentBody, type CanonicalDocumentRow, type CanonicalMemoryReadOptions } from './canonical-memory-read-model'
import { searchCanonicalMemoryWithBroker } from './canonical-memory-broker'
import { listCanonicalRows, searchCanonicalRawMemory, toMemoryListItem } from './canonical-memory-dispatch'
import { parseBrainMemoryRolloutAttribution } from './external-client-memory'
import { parseGoogleSourceReadAttribution } from './google-source-read-contract'
import { getCanonicalMemoryStore } from './canonical-postgres'

export async function searchCanonicalMemory(input: CanonicalSearchInput, env: Env, tenantId: string, options: CanonicalMemoryReadOptions = {}): Promise<CanonicalSearchResult> {
  return (await searchCanonicalMemoryWithBroker(input, env, tenantId, options)).result
}

export async function listRecentCanonicalMemories(input: CanonicalRecentInput, env: Env, tenantId: string, options: CanonicalMemoryReadOptions = {}): Promise<CanonicalRecentResult> {
  const rows = await listCanonicalRows(env, tenantId, input.scope ?? null, clampCanonicalLimit(input.limit, 10, 20))
  return {
    items: await Promise.all(rows.map(async row => toMemoryListItem(
      row,
      options.tmk
        ? await readCanonicalDocumentBody(env, row.body_r2_key, options.tmk).catch(() => null)
        : null,
    ))),
  }
}

export async function getCanonicalDocument(input: CanonicalDocumentInput, env: Env, tenantId: string, options: CanonicalMemoryReadOptions = {}): Promise<CanonicalDocumentResult> {
  if (!options.tmk) throw new Error('Active session key required for canonical document reads')
  const row = await getCanonicalMemoryStore(env).getDocument(tenantId, input.documentId) as CanonicalDocumentRow | null
  if (!row) throw new Error(`Canonical document not found: ${input.documentId}`)
  return {
    captureId: row.capture_id,
    documentId: row.document_id,
    title: row.title,
    scope: row.scope,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    brainMemory: parseBrainMemoryRolloutAttribution({
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
      artifactRef: row.r2_key,
    }),
    googleSource: parseGoogleSourceReadAttribution({
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
    }),
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
        storageKind: row.storage_kind,
        storageKey: row.r2_key,
      }
      : null,
  }
}
