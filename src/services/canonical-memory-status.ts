import type { Env } from '../types/env'
import type { CanonicalMemoryStatusInput, CanonicalMemoryStatusResult } from '../types/canonical-memory-query'
import { buildCanonicalGraphProjectionStatus } from './canonical-graph-projection-design'
import { parseBrainMemoryRolloutAttribution } from './external-client-memory'
import { parseGoogleSourceReadAttribution } from './google-source-read-contract'
import { getCanonicalMemoryStore } from './canonical-postgres'

interface OperationRow {
  id: string; capture_id: string; operation_type: string; status: string; created_at: number; updated_at: number
  source_system: string; source_ref: string | null; scope: string; title: string | null; captured_at: number
}

interface ProjectionRow {
  projection_result_id: string | null; job_id: string; document_id: string; projection_kind: string
  status: string; result_status: string | null; target_ref: string | null; error_message: string | null
  engine_document_id: string | null; engine_operation_id: string | null; result_updated_at: number | null
  availability_source: string | null
}

const isSemanticReady = (row: ProjectionRow): boolean =>
  row.projection_kind === 'hindsight'
  && row.availability_source === 'document'

async function readOperationRow(input: CanonicalMemoryStatusInput, env: Env, tenantId: string): Promise<OperationRow | null> {
  const store = getCanonicalMemoryStore(env)
  return input.operationId
    ? await store.getOperationById(tenantId, input.operationId) as OperationRow | null
    : await store.getLatestOperationForCapture(tenantId, input.captureId ?? '') as OperationRow | null
}

export async function getCanonicalMemoryStatus(input: CanonicalMemoryStatusInput, env: Env, tenantId: string): Promise<CanonicalMemoryStatusResult> {
  if (!input.captureId && !input.operationId) throw new Error('memory_status requires captureId or operationId')
  const operation = await readOperationRow(input, env, tenantId)
  if (!operation) throw new Error('Canonical memory status not found')

  const rows = await Promise.all(
    (await getCanonicalMemoryStore(env).listProjectionStatesForOperation(tenantId, operation.id)).map(async (row) => {
      const availability = row.engine_operation_id
        ? await env.D1_US.prepare(
          `SELECT availability_source
           FROM hindsight_operations
           WHERE operation_id = ?`,
        ).bind(row.engine_operation_id).first<{ availability_source: string | null }>()
        : null
      return {
        ...row,
        availability_source: availability?.availability_source ?? null,
      }
    }),
  ) as ProjectionRow[]

  const graph = rows.find((row) => row.projection_kind === 'graphiti')

  return {
    captureId: operation.capture_id,
    sourceSystem: operation.source_system,
    sourceRef: operation.source_ref,
    scope: operation.scope,
    title: operation.title,
    capturedAt: operation.captured_at,
    brainMemory: parseBrainMemoryRolloutAttribution({ sourceSystem: operation.source_system, sourceRef: operation.source_ref }),
    googleSource: parseGoogleSourceReadAttribution({ sourceSystem: operation.source_system, sourceRef: operation.source_ref }),
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
    // Phase 2: reflection and compatibility retired — Hindsight engine reads severed
    compatibility: null,
    reflection: null,
  }
}
