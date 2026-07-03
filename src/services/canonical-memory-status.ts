import type { Env } from '../types/env'
import type { CanonicalMemoryStatusInput, CanonicalMemoryStatusResult } from '../types/canonical-memory-query'
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

// Engine projections retired in mission Phase 3 — semantic readiness is always false.
const isSemanticReady = (_row: ProjectionRow): boolean => false

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

  // Both engines retired in mission Phase 3 — no rows expected; read anyway for completeness.
  const rows = (await getCanonicalMemoryStore(env)
    .listProjectionStatesForOperation(tenantId, operation.id)) as ProjectionRow[]

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
    // Both engines retired in mission Phase 3 — graph and reflection are null.
    graph: null,
    compatibility: null,
    reflection: null,
  }
}
