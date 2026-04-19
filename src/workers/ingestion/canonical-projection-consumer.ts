import type { Env } from '../../types/env'
import type { CanonicalProjectionDispatchMessage } from '../../types/canonical-capture-pipeline'
import { submitGraphitiProjection } from '../../services/canonical-graphiti-projection'
import { submitHindsightProjection } from '../../services/canonical-hindsight-projection'

export async function processCanonicalProjectionDispatch(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  const typed = payload as CanonicalProjectionDispatchMessage['payload']
  if (typed.operationId == null) throw new Error('canonical_projection_dispatch missing operationId')
  const jobs = await env.D1_US.prepare(
    `SELECT id, projection_kind
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ?`,
  ).bind(tenantId, typed.operationId).all<{ id: string; projection_kind: string }>()
  const requestedKinds = new Set(Array.isArray(typed.projectionKinds) ? typed.projectionKinds : [])
  const queued = jobs.results ?? []
  const hindsightJob = queued.find(job => job.projection_kind === 'hindsight')
  const graphitiJob = queued.find(job => job.projection_kind === 'graphiti')
  const tasks: Promise<unknown>[] = []

  if (requestedKinds.has('hindsight') && hindsightJob) {
    tasks.push(submitHindsightProjection({
      tenantId,
      captureId: String(typed.captureId),
      operationId: String(typed.operationId),
      projectionJobId: hindsightJob.id,
      projectionKind: 'hindsight',
    }, env, ctx).catch((error) => {
      console.error('CANONICAL_HINDSIGHT_PROJECTION_FAILED', {
        tenantId,
        projectionJobId: hindsightJob.id,
        operationId: typed.operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }))
  }
  if (requestedKinds.has('graphiti') && graphitiJob) {
    tasks.push(submitGraphitiProjection({
      tenantId,
      captureId: String(typed.captureId),
      operationId: String(typed.operationId),
      projectionJobId: graphitiJob.id,
      projectionKind: 'graphiti',
    }, env).catch((error) => {
      console.error('CANONICAL_GRAPHITI_PROJECTION_FAILED', {
        tenantId,
        projectionJobId: graphitiJob.id,
        operationId: typed.operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }))
  }

  if (tasks.length > 0) await Promise.allSettled(tasks)
}
