import type { Env } from '../types/env'
import type { HindsightProjectionReconcileResult } from '../types/canonical-capture-pipeline'
import {
  buildTargetRef,
  recordHindsightProjectionState,
  type HindsightProjectionJobRow,
} from './canonical-hindsight-projection-state'
import { getCanonicalMemoryStore } from './canonical-postgres'

interface OperationStateRow extends HindsightProjectionJobRow {
  bank_id: string
  source_document_id: string | null
  status: string
  error_message: string | null
}

export async function reconcileCanonicalHindsightProjection(
  env: Env,
  tenantId: string,
  operationId: string,
): Promise<HindsightProjectionReconcileResult | null> {
  const match = await getCanonicalMemoryStore(env).findHindsightProjectionByEngineOperation(tenantId, operationId)
  if (!match) return null
  const row = await env.D1_US.prepare(
    `SELECT bank_id, source_document_id, status, error_message
     FROM hindsight_operations
     WHERE operation_id = ?
     LIMIT 1`,
  ).bind(operationId).first<Pick<OperationStateRow, 'bank_id' | 'source_document_id' | 'status' | 'error_message'>>()
  if (!row) return null

  const status = row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'queued'
  await recordHindsightProjectionState({
    env,
    tenantId,
    job: { id: match.projection_job_id, operation_id: match.operation_id },
    jobStatus: status,
    resultStatus: status,
    submission: { bankId: row.bank_id, documentId: row.source_document_id, operationId },
    errorMessage: row.error_message,
    auditAction: status === 'completed'
      ? 'memory.projection.hindsight_completed'
      : 'memory.projection.hindsight_failed',
  })

  return {
    projectionJobId: match.projection_job_id,
    projectionStatus: status,
    resultStatus: status,
    targetRef: buildTargetRef({
      bankId: row.bank_id,
      documentId: row.source_document_id,
      operationId,
    }),
    errorMessage: row.error_message,
  }
}
