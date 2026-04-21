import type { Env } from '../types/env'
import { getCanonicalMemoryStore } from './canonical-postgres'

const CAPTURE_KEYS = ['canonical_capture_id', 'canonicalCaptureId', 'capture_id', 'captureId']
const DOCUMENT_KEYS = ['document_id', 'documentId', 'source_document_id', 'sourceDocumentId', 'memory_id', 'memoryId', 'id']
const OPERATION_KEYS = ['canonical_operation_id', 'canonicalOperationId', 'operation_id', 'operationId']

export interface CanonicalSemanticLinkback {
  captureId: string
  documentId: string
  operationId: string
  projectionJobId: string
  projectionResultId: string
  scope: string
  sourceSystem: string
  sourceRef: string | null
  title: string | null
  capturedAt: number
  projectionStatus: string
  resultStatus: string
  targetRef: string | null
  engineDocumentId: string | null
  engineOperationId: string | null
  availabilitySource: string | null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataOf(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {}
}

function parseDocumentIdFromTargetRef(targetRef: string | null): string | null {
  if (!targetRef) return null
  const match = targetRef.match(/\/documents\/([^/]+)/)
  return match?.[1] ?? null
}

function readLookupValue(
  raw: Record<string, unknown>,
  metadata: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const direct = asString(raw[key])
    if (direct) return direct
    const nested = asString(metadata[key])
    if (nested) return nested
  }
  return null
}

export function extractSemanticLookup(raw: Record<string, unknown>): {
  captureId: string | null
  documentId: string | null
  operationId: string | null
  targetRef: string | null
  sourceSystem: string | null
} {
  const metadata = metadataOf(raw)
  const targetRef = readLookupValue(raw, metadata, ['target_ref', 'targetRef'])
  return {
    captureId: readLookupValue(raw, metadata, CAPTURE_KEYS),
    documentId: readLookupValue(raw, metadata, DOCUMENT_KEYS) ?? parseDocumentIdFromTargetRef(targetRef),
    operationId: readLookupValue(raw, metadata, OPERATION_KEYS),
    targetRef,
    sourceSystem: readLookupValue(raw, metadata, ['source', 'source_system', 'sourceSystem']),
  }
}

export async function resolveCanonicalSemanticLinkback(
  raw: Record<string, unknown>,
  env: Env,
  tenantId: string,
): Promise<CanonicalSemanticLinkback | null> {
  const lookup = extractSemanticLookup(raw)
  if (!lookup.captureId && !lookup.documentId && !lookup.operationId && !lookup.targetRef) return null
  const row = await getCanonicalMemoryStore(env).findSemanticLinkback(tenantId, lookup)
  if (!row) return null
  const availability = row.engine_operation_id
    ? await env.D1_US.prepare(
      `SELECT availability_source
       FROM hindsight_operations
       WHERE operation_id = ?`,
    ).bind(row.engine_operation_id).first<{ availability_source: string | null }>()
    : null
  return {
    captureId: row.capture_id,
    documentId: row.document_id,
    operationId: row.operation_id,
    projectionJobId: row.projection_job_id,
    projectionResultId: row.projection_result_id,
    scope: row.scope,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    title: row.title,
    capturedAt: row.captured_at,
    projectionStatus: row.projection_status,
    resultStatus: row.result_status,
    targetRef: row.target_ref,
    engineDocumentId: row.engine_document_id,
    engineOperationId: row.engine_operation_id,
    availabilitySource: availability?.availability_source ?? null,
  }
}
