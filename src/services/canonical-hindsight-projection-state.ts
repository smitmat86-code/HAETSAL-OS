import type { Env } from '../types/env'
import type { HindsightProjectionSubmissionResult } from '../types/canonical-capture-pipeline'
import { buildCanonicalHindsightProjectionAuditBatch } from './canonical-memory-audit'

export interface HindsightProjectionJobRow {
  id: string
  operation_id: string
}

function buildTargetRef(
  submission: Pick<HindsightProjectionSubmissionResult, 'bankId' | 'documentId' | 'operationId'>,
): string | null {
  if (!submission.bankId || !submission.documentId) return null
  return submission.operationId
    ? `hindsight://banks/${submission.bankId}/documents/${submission.documentId}/operations/${submission.operationId}`
    : `hindsight://banks/${submission.bankId}/documents/${submission.documentId}`
}

async function readAggregateOperationStatus(
  env: Env,
  tenantId: string,
  operationId: string,
  currentJobId: string,
  nextJobStatus: 'queued' | 'completed' | 'failed',
): Promise<'accepted' | 'queued' | 'completed' | 'failed'> {
  const rows = await env.D1_US.prepare(
    `SELECT id, status
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ?`,
  ).bind(tenantId, operationId).all<{ id: string; status: string }>()
  const statuses = (rows.results ?? []).map(row =>
    row.id === currentJobId ? nextJobStatus : row.status,
  )
  if (statuses.includes('failed')) return 'failed'
  if (statuses.length > 0 && statuses.every(status => status === 'completed')) return 'completed'
  if (statuses.some(status => status === 'queued' || status === 'completed')) return 'queued'
  return 'accepted'
}

export async function recordHindsightProjectionState(args: {
  env: Env
  tenantId: string
  job: HindsightProjectionJobRow
  jobStatus: 'queued' | 'completed' | 'failed'
  resultStatus: 'queued' | 'completed' | 'failed'
  submission: Pick<HindsightProjectionSubmissionResult, 'bankId' | 'documentId' | 'operationId'>
  errorMessage?: string | null
  auditAction: 'memory.projection.hindsight_started'
    | 'memory.projection.hindsight_queued'
    | 'memory.projection.hindsight_completed'
    | 'memory.projection.hindsight_failed'
}): Promise<void> {
  const latest = await args.env.D1_US.prepare(
    `SELECT status, engine_operation_id, error_message, updated_at
     FROM canonical_projection_results
     WHERE tenant_id = ? AND projection_job_id = ?
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  ).bind(args.tenantId, args.job.id).first<{
    status: string | null
    engine_operation_id: string | null
    error_message: string | null
    updated_at: number | null
  }>()
  if (
    latest?.status === args.resultStatus &&
    latest.engine_operation_id === (args.submission.operationId ?? null) &&
    latest.error_message === (args.errorMessage ?? null) &&
    args.auditAction !== 'memory.projection.hindsight_started'
  ) return

  const operationStatus = await readAggregateOperationStatus(
    args.env,
    args.tenantId,
    args.job.operation_id,
    args.job.id,
    args.jobStatus,
  )
  const updatedAt = Math.max(Date.now(), (latest?.updated_at ?? 0) + 1)
  await args.env.D1_US.batch([
    args.env.D1_US.prepare(
      `UPDATE canonical_memory_operations
       SET status = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(operationStatus, updatedAt, args.tenantId, args.job.operation_id),
    args.env.D1_US.prepare(
      `UPDATE canonical_projection_jobs
       SET status = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(args.jobStatus, args.tenantId, args.job.id),
    args.env.D1_US.prepare(
      `INSERT INTO canonical_projection_results
       (id, tenant_id, projection_job_id, status, target_ref, error_message,
        engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      args.tenantId,
      args.job.id,
      args.resultStatus,
      buildTargetRef(args.submission),
      args.errorMessage ?? null,
      args.submission.bankId,
      args.submission.documentId,
      args.submission.operationId,
      updatedAt,
      updatedAt,
    ),
    ...buildCanonicalHindsightProjectionAuditBatch(args.env.D1_US, {
      tenantId: args.tenantId,
      operationId: args.job.operation_id,
      createdAt: updatedAt,
      action: args.auditAction,
    }),
  ])
}

export { buildTargetRef }
