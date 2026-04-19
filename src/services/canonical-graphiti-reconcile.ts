import type { Env } from '../types/env'
import type { CanonicalGraphIdentityMapping } from '../types/canonical-graph-projection'
import { buildCanonicalGraphitiProjectionAuditBatch } from './canonical-memory-audit'

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
  const rows = await env.D1_US.prepare(
    `SELECT id, status
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ?`,
  ).bind(tenantId, operationId).all<{ id: string; status: string }>()
  const statuses = (rows.results ?? []).map((row) =>
    row.id === currentJobId ? nextJobStatus : row.status,
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
       (id, tenant_id, projection_job_id, status, target_ref, error_message, engine_operation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      args.tenantId,
      args.job.id,
      args.resultStatus,
      args.submission.targetRef,
      args.errorMessage ?? null,
      args.submission.operationRef ?? null,
      updatedAt,
      updatedAt,
    ),
    ...mappings.map((mapping) => args.env.D1_US.prepare(
      `INSERT INTO canonical_graph_identity_mappings
       (id, tenant_id, projection_job_id, canonical_key, graph_ref, graph_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(projection_job_id, canonical_key, graph_kind)
       DO UPDATE SET graph_ref = excluded.graph_ref, updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      args.tenantId,
      args.job.id,
      mapping.canonicalKey,
      mapping.graphRef,
      mapping.graphKind,
      updatedAt,
      updatedAt,
    )),
    ...buildCanonicalGraphitiProjectionAuditBatch(args.env.D1_US, {
      tenantId: args.tenantId,
      operationId: args.job.operation_id,
      createdAt: updatedAt,
      action: args.auditAction,
    }),
  ])
}
