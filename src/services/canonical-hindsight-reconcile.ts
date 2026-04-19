import type { Env } from '../types/env'
import type { HindsightProjectionReconcileResult } from '../types/canonical-capture-pipeline'
import {
  buildTargetRef,
  recordHindsightProjectionState,
  type HindsightProjectionJobRow,
} from './canonical-hindsight-projection-state'

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
  const row = await env.D1_US.prepare(
    `SELECT r.projection_job_id AS id, j.operation_id, o.bank_id, o.source_document_id, o.status, o.error_message
     FROM canonical_projection_results r
     INNER JOIN canonical_projection_jobs j ON j.id = r.projection_job_id
     INNER JOIN hindsight_operations o ON o.operation_id = r.engine_operation_id
     WHERE r.engine_operation_id = ? AND j.tenant_id = ?
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
     LIMIT 1`,
  ).bind(operationId, tenantId).first<OperationStateRow>()
  if (!row) return null

  const status = row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'queued'
  await recordHindsightProjectionState({
    env,
    tenantId,
    job: { id: row.id, operation_id: row.operation_id },
    jobStatus: status,
    resultStatus: status,
    submission: { bankId: row.bank_id, documentId: row.source_document_id, operationId },
    errorMessage: row.error_message,
    auditAction: status === 'completed'
      ? 'memory.projection.hindsight_completed'
      : 'memory.projection.hindsight_failed',
  })

  return {
    projectionJobId: row.id,
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
