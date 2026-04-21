import type { Env } from '../types/env'
import type { HindsightProjectionSubmissionResult } from '../types/canonical-capture-pipeline'
import { buildCanonicalHindsightProjectionAuditBatch } from './canonical-memory-audit'
import { getCanonicalMemoryStore } from './canonical-postgres'

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
  const rows = await getCanonicalMemoryStore(env).listProjectionStatesForOperation(tenantId, operationId)
  const statuses = rows.map(row =>
    row.job_id === currentJobId ? nextJobStatus : row.status,
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
  const latest = await getCanonicalMemoryStore(args.env).getLatestProjectionResult(args.tenantId, args.job.id)
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
  await getCanonicalMemoryStore(args.env).recordProjectionState({
    tenantId: args.tenantId,
    jobId: args.job.id,
    operationId: args.job.operation_id,
    jobStatus: args.jobStatus,
    resultStatus: args.resultStatus,
    targetRef: buildTargetRef(args.submission),
    errorMessage: args.errorMessage ?? null,
    engineBankId: args.submission.bankId,
    engineDocumentId: args.submission.documentId,
    engineOperationId: args.submission.operationId,
    updatedAt,
  })
  await args.env.D1_US.batch(buildCanonicalHindsightProjectionAuditBatch(args.env.D1_US, {
      tenantId: args.tenantId,
      operationId: args.job.operation_id,
      createdAt: updatedAt,
      action: args.auditAction,
    }))
}

export { buildTargetRef }
