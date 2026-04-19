import type { Env } from '../types/env'
import type {
  CanonicalMemoryStatusInput,
  CanonicalMemoryStatusResult,
} from '../types/canonical-memory-query'
import { buildCanonicalGraphProjectionStatus } from './canonical-graph-projection-design'
import { readCanonicalHindsightReflectionStatus } from './canonical-hindsight-reflection-status'

interface OperationRow {
  id: string
  capture_id: string
  operation_type: string
  status: string
  created_at: number
  updated_at: number
}

interface ProjectionRow {
  projection_result_id: string | null
  job_id: string
  document_id: string
  projection_kind: string
  status: string
  result_status: string | null
  target_ref: string | null
  error_message: string | null
  engine_document_id: string | null
  engine_operation_id: string | null
  result_updated_at: number | null
}

function normalizeCompatibilityStatus(
  status: string | null,
): 'queued' | 'retained' | 'failed' | null {
  if (!status) return null
  if (status === 'completed' || status === 'compatibility_completed') return 'retained'
  if (status === 'failed' || status === 'compatibility_failed') return 'failed'
  if (status === 'queued' || status === 'compatibility_queued') return 'queued'
  return null
}

function isSemanticReady(row: ProjectionRow): boolean {
  return row.projection_kind === 'hindsight' &&
    row.status === 'completed' &&
    row.result_status === 'completed'
}

export async function getCanonicalMemoryStatus(
  input: CanonicalMemoryStatusInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalMemoryStatusResult> {
  if (!input.captureId && !input.operationId) {
    throw new Error('memory_status requires captureId or operationId')
  }
  const operation = input.operationId
    ? await env.D1_US.prepare(
      `SELECT id, capture_id, operation_type, status, created_at, updated_at
       FROM canonical_memory_operations
       WHERE tenant_id = ? AND id = ?`,
    ).bind(tenantId, input.operationId).first<OperationRow>()
    : await env.D1_US.prepare(
      `SELECT id, capture_id, operation_type, status, created_at, updated_at
       FROM canonical_memory_operations
       WHERE tenant_id = ? AND capture_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).bind(tenantId, input.captureId ?? null).first<OperationRow>()
  if (!operation) throw new Error('Canonical memory status not found')

  const projections = await env.D1_US.prepare(
    `SELECT j.id AS job_id, j.document_id, j.projection_kind, j.status,
            r.id AS projection_result_id, r.status AS result_status, r.target_ref, r.error_message,
            r.engine_document_id, r.engine_operation_id, r.updated_at AS result_updated_at
     FROM canonical_projection_jobs j
     LEFT JOIN canonical_projection_results r ON r.id = (
       SELECT r2.id
       FROM canonical_projection_results r2
       WHERE r2.projection_job_id = j.id
       ORDER BY r2.updated_at DESC, r2.created_at DESC, r2.id DESC
       LIMIT 1
     )
     WHERE j.tenant_id = ? AND j.operation_id = ?
     ORDER BY j.projection_kind ASC`,
  ).bind(tenantId, operation.id).all<ProjectionRow>()
  const compatibility = (projections.results ?? []).find(row => row.projection_kind === 'hindsight')
  const graph = (projections.results ?? []).find(row => row.projection_kind === 'graphiti')
  const compatibilityStatus = normalizeCompatibilityStatus(compatibility?.result_status ?? compatibility?.status ?? null)
  const reflection = await readCanonicalHindsightReflectionStatus({
    env,
    tenantId,
    operationId: operation.id,
    semanticReady: compatibility ? isSemanticReady(compatibility) : false,
    projectedAt: compatibility?.result_updated_at ?? null,
  })

  return {
    captureId: operation.capture_id,
    operation: {
      operationId: operation.id,
      operationType: operation.operation_type,
      status: operation.status,
      createdAt: operation.created_at,
      updatedAt: operation.updated_at,
    },
    projections: (projections.results ?? []).map(row => ({
      jobId: row.job_id,
      documentId: row.document_id,
      kind: row.projection_kind,
      status: row.status,
      resultStatus: row.result_status,
      targetRef: row.target_ref,
      errorMessage: row.error_message,
      projectionResultId: row.projection_result_id,
      engineDocumentId: row.engine_document_id,
      engineOperationId: row.engine_operation_id,
      semanticReady: isSemanticReady(row),
      updatedAt: row.result_updated_at,
    })),
    graph: buildCanonicalGraphProjectionStatus(graph
      ? {
        jobId: graph.job_id,
        kind: graph.projection_kind,
        status: graph.status,
        resultStatus: graph.result_status,
        targetRef: graph.target_ref,
        errorMessage: graph.error_message,
        projectionResultId: graph.projection_result_id,
        updatedAt: graph.result_updated_at,
      }
      : null),
    compatibility: compatibility && compatibilityStatus
      ? {
        mode: 'current_hindsight',
        status: compatibilityStatus,
        targetRef: compatibility.target_ref,
        errorMessage: compatibility.error_message,
        updatedAt: compatibility.result_updated_at,
      }
      : null,
    reflection,
  }
}
