import type { Env } from '../types/env'
import type { CanonicalGraphIdentityMapping } from '../types/canonical-graph-projection'
import { buildCanonicalGraphitiProjectionAuditBatch } from './canonical-memory-audit'
import { getCanonicalMemoryStore } from './canonical-postgres'

interface GraphitiProjectionJobRow {
  id: string
  operation_id: string
}

interface GraphitiProjectionStateInput {
  targetRef: string | null
  operationRef?: string | null
  mappings: CanonicalGraphIdentityMapping[]
}

function dedupeMappings(
  mappings: CanonicalGraphIdentityMapping[],
): CanonicalGraphIdentityMapping[] {
  const seen = new Set<string>()
  return mappings.filter((mapping) => {
    const key = `${mapping.graphKind}:${mapping.canonicalKey}:${mapping.graphRef}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function readAggregateOperationStatus(
  env: Env,
  tenantId: string,
  operationId: string,
  currentJobId: string,
  nextJobStatus: 'queued' | 'completed' | 'failed',
): Promise<'accepted' | 'queued' | 'completed' | 'failed'> {
  const rows = await getCanonicalMemoryStore(env).listProjectionStatesForOperation(tenantId, operationId)
  const statuses = rows.map((row) =>
    row.job_id === currentJobId ? nextJobStatus : row.status,
  )
  if (statuses.includes('failed')) return 'failed'
  if (statuses.length > 0 && statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.some((status) => status === 'queued' || status === 'completed')) return 'queued'
  return 'accepted'
}

export async function recordGraphitiProjectionState(args: {
  env: Env
  tenantId: string
  job: GraphitiProjectionJobRow
  jobStatus: 'queued' | 'completed' | 'failed'
  resultStatus: 'queued' | 'completed' | 'failed'
  submission: GraphitiProjectionStateInput
  errorMessage?: string | null
  auditAction: 'memory.projection.graphiti_started'
    | 'memory.projection.graphiti_queued'
    | 'memory.projection.graphiti_completed'
    | 'memory.projection.graphiti_failed'
}): Promise<void> {
  const updatedAt = Date.now()
  const operationStatus = await readAggregateOperationStatus(
    args.env,
    args.tenantId,
    args.job.operation_id,
    args.job.id,
    args.jobStatus,
  )
  const mappings = dedupeMappings(args.submission.mappings)

  await getCanonicalMemoryStore(args.env).recordProjectionState({
    tenantId: args.tenantId,
    jobId: args.job.id,
    operationId: args.job.operation_id,
    jobStatus: args.jobStatus,
    resultStatus: args.resultStatus,
    targetRef: args.submission.targetRef,
    errorMessage: args.errorMessage ?? null,
    engineOperationId: args.submission.operationRef ?? null,
    updatedAt,
    graphMappings: mappings,
  })
  await args.env.D1_US.batch(buildCanonicalGraphitiProjectionAuditBatch(args.env.D1_US, {
      tenantId: args.tenantId,
      operationId: args.job.operation_id,
      createdAt: updatedAt,
      action: args.auditAction,
    }))
}
