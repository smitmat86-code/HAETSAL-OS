import type { Env } from '../types/env'

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
  const row = await env.D1_US.prepare(
    `SELECT c.id AS capture_id, d.id AS document_id, o.id AS operation_id,
            j.id AS projection_job_id, r.id AS projection_result_id,
            c.scope, c.source_system, c.source_ref, d.title, c.captured_at,
            j.status AS projection_status, r.status AS result_status,
            r.target_ref, r.engine_document_id, r.engine_operation_id
     FROM canonical_projection_results r
     INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
     INNER JOIN canonical_captures c ON c.id = j.capture_id
     INNER JOIN canonical_documents d ON d.id = j.document_id
     INNER JOIN canonical_memory_operations o ON o.id = j.operation_id
     WHERE j.tenant_id = ?
       AND j.projection_kind = 'hindsight'
       AND (
         (? IS NOT NULL AND c.id = ?)
         OR (? IS NOT NULL AND r.engine_document_id = ?)
         OR (? IS NOT NULL AND r.engine_operation_id = ?)
         OR (? IS NOT NULL AND r.target_ref = ?)
       )
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
     LIMIT 1`,
  ).bind(
    tenantId,
    lookup.captureId,
    lookup.captureId,
    lookup.documentId,
    lookup.documentId,
    lookup.operationId,
    lookup.operationId,
    lookup.targetRef,
    lookup.targetRef,
  ).first<{
    capture_id: string
    document_id: string
    operation_id: string
    projection_job_id: string
    projection_result_id: string
    scope: string
    source_system: string
    source_ref: string | null
    title: string | null
    captured_at: number
    projection_status: string
    result_status: string
    target_ref: string | null
    engine_document_id: string | null
    engine_operation_id: string | null
  }>()
  if (!row) return null
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
  }
}
