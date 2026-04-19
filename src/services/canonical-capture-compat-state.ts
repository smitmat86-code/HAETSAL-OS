import type { Env } from '../types/env'
import type { CompatibilityRetainResult } from '../types/canonical-capture-pipeline'
import { buildCanonicalCompatibilityAuditBatch } from './canonical-memory-audit'

interface ProjectionJobRow {
  id: string
}

function buildCompatibilityTargetRef(result: CompatibilityRetainResult): string | null {
  if (result.operationId) return `hindsight://operations/${result.operationId}`
  if (result.memoryId) return `hindsight://memories/${result.memoryId}`
  return null
}

export function toCompatibilityResult(
  mode: CompatibilityRetainResult['mode'],
  status: CompatibilityRetainResult['status'],
  memoryId: string | null,
  operationId: string | null,
  documentId: string | null,
  stoneR2Key: string | null,
  errorMessage?: string | null,
): CompatibilityRetainResult {
  return {
    mode,
    status,
    memoryId,
    operationId,
    documentId,
    stoneR2Key,
    errorMessage: errorMessage ?? null,
  }
}

async function getHindsightProjectionJob(
  env: Env,
  tenantId: string,
  operationId: string,
): Promise<ProjectionJobRow> {
  const row = await env.D1_US.prepare(
    `SELECT id
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ? AND projection_kind = 'hindsight'
     LIMIT 1`,
  ).bind(tenantId, operationId).first<ProjectionJobRow>()
  if (!row) throw new Error(`Missing hindsight projection job for canonical operation ${operationId}`)
  return row
}

export async function recordCompatibilityState(
  env: Env,
  tenantId: string,
  canonicalOperationId: string,
  result: CompatibilityRetainResult,
): Promise<void> {
  const job = await getHindsightProjectionJob(env, tenantId, canonicalOperationId)
  const updatedAt = Date.now()
  const status = result.status === 'retained'
    ? 'compatibility_completed'
    : `compatibility_${result.status}`

  await env.D1_US.batch([
    env.D1_US.prepare(
      `INSERT INTO canonical_projection_results
       (id, tenant_id, projection_job_id, status, target_ref, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      tenantId,
      job.id,
      status,
      buildCompatibilityTargetRef(result),
      result.errorMessage ?? null,
      updatedAt,
      updatedAt,
    ),
    ...buildCanonicalCompatibilityAuditBatch(env.D1_US, {
      tenantId,
      operationId: canonicalOperationId,
      createdAt: updatedAt,
      failed: result.status === 'failed',
    }),
  ])
}
