import type { Env } from '../types/env'
import { buildCanonicalHindsightReflectionAuditBatch } from './canonical-memory-audit'

export type CanonicalHindsightReflectionAuditAction =
  | 'memory.projection.hindsight_reflect_started'
  | 'memory.projection.hindsight_reflect_completed'
  | 'memory.projection.hindsight_reflect_failed'

export interface CanonicalHindsightReflectionRun {
  runId: string
  tenantId: string
  bankId: string
  operationIds: string[]
}

interface CompletedProjectionRow {
  operation_id: string
}

interface LatestReflectionAuditRow {
  operation: CanonicalHindsightReflectionAuditAction
}

async function listCompletedHindsightOperations(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const rows = await env.D1_US.prepare(
    `SELECT j.operation_id
     FROM canonical_projection_jobs j
     INNER JOIN canonical_projection_results r ON r.id = (
       SELECT r2.id
       FROM canonical_projection_results r2
       WHERE r2.projection_job_id = j.id
       ORDER BY r2.updated_at DESC, r2.created_at DESC, r2.id DESC
       LIMIT 1
     )
     WHERE j.tenant_id = ? AND j.projection_kind = 'hindsight' AND r.status = 'completed'
     ORDER BY j.operation_id ASC`,
  ).bind(tenantId).all<CompletedProjectionRow>()
  return (rows.results ?? []).map(row => row.operation_id)
}

async function readLatestReflectionAuditAction(
  env: Env,
  tenantId: string,
  operationId: string,
): Promise<CanonicalHindsightReflectionAuditAction | null> {
  const row = await env.D1_US.prepare(
    `SELECT operation
     FROM memory_audit
     WHERE tenant_id = ? AND memory_id = ? AND operation IN (
       'memory.projection.hindsight_reflect_started',
       'memory.projection.hindsight_reflect_completed',
       'memory.projection.hindsight_reflect_failed'
     )
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).bind(tenantId, operationId).first<LatestReflectionAuditRow>()
  return row?.operation ?? null
}

async function listEligibleReflectionOperations(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const operationIds = await listCompletedHindsightOperations(env, tenantId)
  if (!operationIds.length) return []

  const latestActions = await Promise.all(operationIds.map(operationId =>
    readLatestReflectionAuditAction(env, tenantId, operationId),
  ))

  return operationIds.filter((_, index) => latestActions[index] !== 'memory.projection.hindsight_reflect_completed')
}

async function writeReflectionAuditBatch(args: {
  env: Env
  tenantId: string
  operationIds: string[]
  action: CanonicalHindsightReflectionAuditAction
}): Promise<void> {
  if (!args.operationIds.length) return
  const createdAt = Date.now()
  await args.env.D1_US.batch(
    args.operationIds.flatMap(operationId => buildCanonicalHindsightReflectionAuditBatch(args.env.D1_US, {
      tenantId: args.tenantId,
      operationId,
      createdAt,
      action: args.action,
    })),
  )
}

export async function startCanonicalHindsightReflectionRun(args: {
  env: Env
  tenantId: string
  bankId: string
  runId: string
}): Promise<CanonicalHindsightReflectionRun> {
  const operationIds = await listEligibleReflectionOperations(args.env, args.tenantId)
  await writeReflectionAuditBatch({
    env: args.env,
    tenantId: args.tenantId,
    operationIds,
    action: 'memory.projection.hindsight_reflect_started',
  })
  return {
    runId: args.runId,
    tenantId: args.tenantId,
    bankId: args.bankId,
    operationIds,
  }
}

export async function completeCanonicalHindsightReflectionRun(
  run: CanonicalHindsightReflectionRun,
  env: Env,
): Promise<void> {
  await writeReflectionAuditBatch({
    env,
    tenantId: run.tenantId,
    operationIds: run.operationIds,
    action: 'memory.projection.hindsight_reflect_completed',
  })
}

export async function failCanonicalHindsightReflectionRun(
  run: CanonicalHindsightReflectionRun,
  env: Env,
): Promise<void> {
  await writeReflectionAuditBatch({
    env,
    tenantId: run.tenantId,
    operationIds: run.operationIds,
    action: 'memory.projection.hindsight_reflect_failed',
  })
}
