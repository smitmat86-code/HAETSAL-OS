import type { Env } from '../../types/env'
import type { CanonicalProjectionDispatchMessage } from '../../types/canonical-capture-pipeline'
import { submitHindsightProjection } from '../../services/canonical-hindsight-projection'

export async function processCanonicalProjectionDispatch(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  const typed = payload as CanonicalProjectionDispatchMessage['payload']
  if (typed.operationId == null) throw new Error('canonical_projection_dispatch missing operationId')
  const job = await env.D1_US.prepare(
    `SELECT id
     FROM canonical_projection_jobs
     WHERE tenant_id = ? AND operation_id = ? AND projection_kind = 'hindsight'
     LIMIT 1`,
  ).bind(tenantId, typed.operationId).first<{ id: string }>()
  if (!job || !Array.isArray(typed.projectionKinds) || !typed.projectionKinds.includes('hindsight')) {
    return
  }

  try {
    await submitHindsightProjection({
      tenantId,
      captureId: String(typed.captureId),
      operationId: String(typed.operationId),
      projectionJobId: job.id,
      projectionKind: 'hindsight',
    }, env, ctx)
  } catch (error) {
    console.error('CANONICAL_HINDSIGHT_PROJECTION_FAILED', {
      tenantId,
      projectionJobId: job.id,
      operationId: typed.operationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
