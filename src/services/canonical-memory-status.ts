import type { Env } from '../types/env'
import type { CanonicalMemoryStatusInput, CanonicalMemoryStatusResult } from '../types/canonical-memory-query'
import { buildCanonicalGraphProjectionStatus } from './canonical-graph-projection-design'
import { readCanonicalHindsightReflectionStatus } from './canonical-hindsight-reflection-status'
import { parseBrainMemoryRolloutAttribution } from './external-client-memory'

interface OperationRow {
  id: string; capture_id: string; operation_type: string; status: string; created_at: number; updated_at: number
  source_system: string; source_ref: string | null; scope: string; title: string | null; captured_at: number
}

interface ProjectionRow {
  projection_result_id: string | null; job_id: string; document_id: string; projection_kind: string
  status: string; result_status: string | null; target_ref: string | null; error_message: string | null
  engine_document_id: string | null; engine_operation_id: string | null; result_updated_at: number | null
}

const normalizeCompatibilityStatus = (status: string | null): 'queued' | 'retained' | 'failed' | null =>
  !status ? null
    : status === 'completed' || status === 'compatibility_completed' ? 'retained'
      : status === 'failed' || status === 'compatibility_failed' ? 'failed'
        : status === 'queued' || status === 'compatibility_queued' ? 'queued'
          : null

const isSemanticReady = (row: ProjectionRow): boolean =>
  row.projection_kind === 'hindsight' && row.status === 'completed' && row.result_status === 'completed'

async function readOperationRow(input: CanonicalMemoryStatusInput, env: Env, tenantId: string): Promise<OperationRow | null> {
  return input.operationId
    ? env.D1_US.prepare(
      `SELECT o.id, o.capture_id, o.operation_type, o.status, o.created_at, o.updated_at,
              c.source_system, c.source_ref, c.scope, c.title, c.captured_at
       FROM canonical_memory_operations o
       INNER JOIN canonical_captures c ON c.id = o.capture_id
       WHERE o.tenant_id = ? AND o.id = ?`,
    ).bind(tenantId, input.operationId).first<OperationRow>()
    : env.D1_US.prepare(
      `SELECT o.id, o.capture_id, o.operation_type, o.status, o.created_at, o.updated_at,
              c.source_system, c.source_ref, c.scope, c.title, c.captured_at
       FROM canonical_memory_operations o
       INNER JOIN canonical_captures c ON c.id = o.capture_id
       WHERE o.tenant_id = ? AND o.capture_id = ?
       ORDER BY o.created_at DESC LIMIT 1`,
    ).bind(tenantId, input.captureId ?? null).first<OperationRow>()
}

export async function getCanonicalMemoryStatus(input: CanonicalMemoryStatusInput, env: Env, tenantId: string): Promise<CanonicalMemoryStatusResult> {
  if (!input.captureId && !input.operationId) throw new Error('memory_status requires captureId or operationId')
  const operation = await readOperationRow(input, env, tenantId)
  if (!operation) throw new Error('Canonical memory status not found')

  const projections = await env.D1_US.prepare(
    `SELECT j.id AS job_id, j.document_id, j.projection_kind, j.status,
            r.id AS projection_result_id, r.status AS result_status, r.target_ref, r.error_message,
            r.engine_document_id, r.engine_operation_id, r.updated_at AS result_updated_at
     FROM canonical_projection_jobs j
     LEFT JOIN canonical_projection_results r ON r.id = (
       SELECT r2.id FROM canonical_projection_results r2
       WHERE r2.projection_job_id = j.id
       ORDER BY r2.updated_at DESC, r2.created_at DESC, r2.id DESC LIMIT 1
     )
     WHERE j.tenant_id = ? AND j.operation_id = ?
     ORDER BY j.projection_kind ASC`,
  ).bind(tenantId, operation.id).all<ProjectionRow>()
  const rows = projections.results ?? []
  const compatibility = rows.find((row) => row.projection_kind === 'hindsight')
  const graph = rows.find((row) => row.projection_kind === 'graphiti')
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
    sourceSystem: operation.source_system,
    sourceRef: operation.source_ref,
    scope: operation.scope,
    title: operation.title,
    capturedAt: operation.captured_at,
    brainMemory: parseBrainMemoryRolloutAttribution({ sourceSystem: operation.source_system, sourceRef: operation.source_ref }),
    operation: {
      operationId: operation.id,
      operationType: operation.operation_type,
      status: operation.status,
      createdAt: operation.created_at,
      updatedAt: operation.updated_at,
    },
    projections: rows.map((row) => ({
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
    graph: buildCanonicalGraphProjectionStatus(graph ? {
      jobId: graph.job_id,
      kind: graph.projection_kind,
      status: graph.status,
      resultStatus: graph.result_status,
      targetRef: graph.target_ref,
      errorMessage: graph.error_message,
      projectionResultId: graph.projection_result_id,
      updatedAt: graph.result_updated_at,
    } : null),
    compatibility: compatibility && compatibilityStatus ? {
      mode: 'current_hindsight',
      status: compatibilityStatus,
      targetRef: compatibility.target_ref,
      errorMessage: compatibility.error_message,
      updatedAt: compatibility.result_updated_at,
    } : null,
    reflection,
  }
}
