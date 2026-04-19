import type { Env } from '../types/env'
import type { CanonicalProjectionDispatchMessage } from '../types/canonical-capture-pipeline'
import {
  buildCanonicalCaptureFailedAuditBatch,
  buildCanonicalProjectionQueuedAuditBatch,
} from './canonical-memory-audit'

interface ProjectionJobRow {
  id: string
  projection_kind: string
}

async function listProjectionJobs(
  env: Env,
  tenantId: string,
  operationId: string,
): Promise<ProjectionJobRow[]> {
  const rows = await env.D1_US.prepare(
    `SELECT id, projection_kind
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ?
     ORDER BY projection_kind ASC`,
  ).bind(tenantId, operationId).all<ProjectionJobRow>()
  return rows.results ?? []
}

export async function enqueueCanonicalProjectionDispatch(
  message: CanonicalProjectionDispatchMessage,
  env: Env,
): Promise<void> {
  await env.QUEUE_BULK.send(message)
  const jobs = await listProjectionJobs(env, message.tenantId, message.payload.operationId)
  const queuedAt = Date.now()

  await env.D1_US.batch([
    env.D1_US.prepare(
      `UPDATE canonical_memory_operations
       SET status = 'queued', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(queuedAt, message.tenantId, message.payload.operationId),
    ...jobs.map(job => env.D1_US.prepare(
      `UPDATE canonical_projection_jobs
       SET status = 'queued', enqueued_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(queuedAt, message.tenantId, job.id)),
    ...jobs.map(job => env.D1_US.prepare(
      `INSERT INTO canonical_projection_results
       (id, tenant_id, projection_job_id, status, target_ref, error_message, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?)`,
    ).bind(crypto.randomUUID(), message.tenantId, job.id, queuedAt, queuedAt)),
    ...buildCanonicalProjectionQueuedAuditBatch(env.D1_US, {
      tenantId: message.tenantId,
      operationId: message.payload.operationId,
      projectionKinds: message.payload.projectionKinds,
      createdAt: queuedAt,
    }),
  ])
}

export async function markCanonicalProjectionDispatchFailed(
  message: CanonicalProjectionDispatchMessage,
  env: Env,
  error: unknown,
): Promise<void> {
  const jobs = await listProjectionJobs(env, message.tenantId, message.payload.operationId)
  const failedAt = Date.now()
  const detail = error instanceof Error ? error.message : String(error)

  await env.D1_US.batch([
    env.D1_US.prepare(
      `UPDATE canonical_memory_operations
       SET status = 'failed', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(failedAt, message.tenantId, message.payload.operationId),
    ...jobs.map(job => env.D1_US.prepare(
      `UPDATE canonical_projection_jobs
       SET status = 'failed'
       WHERE tenant_id = ? AND id = ?`,
    ).bind(message.tenantId, job.id)),
    ...jobs.map(job => env.D1_US.prepare(
      `INSERT INTO canonical_projection_results
       (id, tenant_id, projection_job_id, status, target_ref, error_message, created_at, updated_at)
       VALUES (?, ?, ?, 'failed', NULL, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), message.tenantId, job.id, detail, failedAt, failedAt)),
    ...buildCanonicalCaptureFailedAuditBatch(env.D1_US, {
      tenantId: message.tenantId,
      operationId: message.payload.operationId,
      createdAt: failedAt,
    }),
  ])
}
