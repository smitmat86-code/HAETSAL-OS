import type { Env } from '../../types/env'
import type { CanonicalProjectionDispatchMessage } from '../../types/canonical-capture-pipeline'
import { submitGraphitiProjection } from '../../services/canonical-graphiti-projection'
import { getCanonicalMemoryStore } from '../../services/canonical-postgres'

export async function processCanonicalProjectionDispatch(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  void ctx
  const typed = payload as CanonicalProjectionDispatchMessage['payload']
  if (typed.operationId == null) throw new Error('canonical_projection_dispatch missing operationId')
  const queued = await getCanonicalMemoryStore(env).listProjectionJobsForOperation(tenantId, String(typed.operationId))
  const requestedKinds = new Set(Array.isArray(typed.projectionKinds) ? typed.projectionKinds : [])
  const graphitiJob = queued.find(job => job.projection_kind === 'graphiti')

  if (requestedKinds.has('hindsight')) {
    // Write path severed in mission Phase 1: legacy queued hindsight jobs are
    // skipped, never retained. Historical rows drain via Phase 3 removal.
    console.warn('CANONICAL_HINDSIGHT_PROJECTION_SKIPPED_SEVERED', {
      tenantId,
      operationId: typed.operationId,
    })
  }

  if (requestedKinds.has('graphiti') && graphitiJob) {
    await submitGraphitiProjection({
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
    })
  }
}
