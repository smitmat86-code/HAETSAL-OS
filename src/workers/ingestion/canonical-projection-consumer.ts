import type { Env } from '../../types/env'
import type { CanonicalProjectionDispatchMessage } from '../../types/canonical-capture-pipeline'

export async function processCanonicalProjectionDispatch(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<void> {
  void ctx
  void env
  const typed = payload as CanonicalProjectionDispatchMessage['payload']
  if (typed.operationId == null) throw new Error('canonical_projection_dispatch missing operationId')
  const requestedKinds = Array.isArray(typed.projectionKinds) ? typed.projectionKinds : []

  // Projection engines are retired (Hindsight: mission Phase 1, Graphiti:
  // Phase 2). Legacy queued engine jobs are skipped, never dispatched;
  // historical rows drain with the Phase 3 removal. Future projections
  // (e.g. AI Search) re-enter through this consumer.
  if (requestedKinds.length > 0) {
    console.warn('CANONICAL_PROJECTION_SKIPPED_RETIRED_ENGINE', {
      tenantId,
      operationId: typed.operationId,
      requestedKinds,
    })
  }
}
