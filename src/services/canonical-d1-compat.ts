import type { Env } from '../types/env'
import type { CanonicalGraphIdentityMapping } from '../types/canonical-graph-projection'
import type { CanonicalCaptureWrite } from './canonical-postgres-schema'

function dedupeMappings(
  mappings: CanonicalGraphIdentityMapping[] | undefined,
): CanonicalGraphIdentityMapping[] {
  const seen = new Set<string>()
  return (mappings ?? []).filter((mapping) => {
    const key = `${mapping.graphKind}:${mapping.canonicalKey}:${mapping.graphRef}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function computeAggregateOperationStatus(
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

export async function mirrorCanonicalCaptureWrite(
  env: Env,
  input: CanonicalCaptureWrite,
): Promise<void> {
  await env.D1_US.batch([
    env.D1_US.prepare(
      `INSERT INTO canonical_captures
       (id, tenant_id, source_system, source_ref, scope, title, body_r2_key, body_sha256, artifact_id, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.capture.id,
      input.capture.tenant_id,
      input.capture.source_system,
      input.capture.source_ref,
      input.capture.scope,
      input.capture.title,
      input.capture.body_r2_key,
      input.capture.body_sha256,
      input.capture.artifact_id,
      input.capture.captured_at,
      input.capture.created_at,
    ),
    ...(input.artifact ? [env.D1_US.prepare(
      `INSERT INTO canonical_artifacts
       (id, tenant_id, capture_id, storage_kind, r2_key, media_type, filename, byte_length, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.artifact.id,
      input.artifact.tenant_id,
      input.artifact.capture_id,
      input.artifact.storage_kind,
      input.artifact.r2_key,
      input.artifact.media_type,
      input.artifact.filename,
      input.artifact.byte_length,
      input.artifact.sha256,
      input.artifact.created_at,
    )] : []),
    env.D1_US.prepare(
      `INSERT INTO canonical_documents
       (id, tenant_id, capture_id, artifact_id, title, body_r2_key, body_sha256, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.document.id,
      input.document.tenant_id,
      input.document.capture_id,
      input.document.artifact_id,
      input.document.title,
      input.document.body_r2_key,
      input.document.body_sha256,
      input.document.chunk_count,
      input.document.created_at,
    ),
    ...input.chunks.map((chunk) => env.D1_US.prepare(
      `INSERT INTO canonical_chunks
       (id, tenant_id, document_id, ordinal, start_offset, end_offset, chunk_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      chunk.id,
      chunk.tenant_id,
      chunk.document_id,
      chunk.ordinal,
      chunk.start_offset,
      chunk.end_offset,
      chunk.chunk_sha256,
      chunk.created_at,
    )),
    env.D1_US.prepare(
      `INSERT INTO canonical_memory_operations
       (id, tenant_id, capture_id, operation_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.operation.id,
      input.operation.tenant_id,
      input.operation.capture_id,
      input.operation.operation_type,
      input.operation.status,
      input.operation.created_at,
      input.operation.updated_at,
    ),
    ...input.projectionJobs.map((job) => env.D1_US.prepare(
      `INSERT INTO canonical_projection_jobs
       (id, tenant_id, operation_id, capture_id, document_id, projection_kind, status, created_at, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      job.id,
      job.tenant_id,
      job.operation_id,
      job.capture_id,
      job.document_id,
      job.projection_kind,
      job.status,
      job.created_at,
      job.enqueued_at,
    )),
  ])
}

export async function mirrorCanonicalDispatchState(args: {
  env: Env
  tenantId: string
  operationId: string
  status: 'queued' | 'failed'
  updatedAt: number
  errorMessage?: string | null
}): Promise<void> {
  const jobs = await args.env.D1_US.prepare(
    `SELECT id
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ?`,
  ).bind(args.tenantId, args.operationId).all<{ id: string }>()
  await args.env.D1_US.batch([
    args.env.D1_US.prepare(
      `UPDATE canonical_memory_operations
       SET status = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(args.status, args.updatedAt, args.tenantId, args.operationId),
    ...(jobs.results ?? []).map((job) => args.env.D1_US.prepare(
      `UPDATE canonical_projection_jobs
       SET status = ?, enqueued_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(args.status, args.updatedAt, args.tenantId, job.id)),
    ...(jobs.results ?? []).map((job) => args.env.D1_US.prepare(
      `INSERT INTO canonical_projection_results
       (id, tenant_id, projection_job_id, status, target_ref, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      args.tenantId,
      job.id,
      args.status,
      args.status === 'failed' ? args.errorMessage ?? null : null,
      args.updatedAt,
      args.updatedAt,
    )),
  ])
}

export async function mirrorCanonicalProjectionState(args: {
  env: Env
  tenantId: string
  jobId: string
  operationId: string
  jobStatus: 'queued' | 'completed' | 'failed'
  resultStatus: 'queued' | 'completed' | 'failed'
  targetRef: string | null
  errorMessage?: string | null
  engineBankId?: string | null
  engineDocumentId?: string | null
  engineOperationId?: string | null
  updatedAt: number
  graphMappings?: CanonicalGraphIdentityMapping[]
}): Promise<void> {
  const operationStatus = await computeAggregateOperationStatus(
    args.env,
    args.tenantId,
    args.operationId,
    args.jobId,
    args.jobStatus,
  )
  await args.env.D1_US.batch([
    args.env.D1_US.prepare(
      `UPDATE canonical_memory_operations
       SET status = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(operationStatus, args.updatedAt, args.tenantId, args.operationId),
    args.env.D1_US.prepare(
      `UPDATE canonical_projection_jobs
       SET status = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(args.jobStatus, args.tenantId, args.jobId),
    args.env.D1_US.prepare(
      `INSERT INTO canonical_projection_results
       (id, tenant_id, projection_job_id, status, target_ref, error_message,
        engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      args.tenantId,
      args.jobId,
      args.resultStatus,
      args.targetRef,
      args.errorMessage ?? null,
      args.engineBankId ?? null,
      args.engineDocumentId ?? null,
      args.engineOperationId ?? null,
      args.updatedAt,
      args.updatedAt,
    ),
    ...dedupeMappings(args.graphMappings).map((mapping) => args.env.D1_US.prepare(
      `INSERT INTO canonical_graph_identity_mappings
       (id, tenant_id, projection_job_id, canonical_key, graph_ref, graph_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(projection_job_id, canonical_key, graph_kind)
       DO UPDATE SET graph_ref = excluded.graph_ref, updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      args.tenantId,
      args.jobId,
      mapping.canonicalKey,
      mapping.graphRef,
      mapping.graphKind,
      args.updatedAt,
      args.updatedAt,
    )),
  ])
}
