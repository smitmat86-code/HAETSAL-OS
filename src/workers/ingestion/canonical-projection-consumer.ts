import type { Env } from '../../types/env'

export async function processCanonicalProjectionDispatch(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
): Promise<void> {
  const operationId = typeof payload.operationId === 'string' ? payload.operationId : null
  if (!operationId) throw new Error('canonical_projection_dispatch missing operationId')

  const row = await env.D1_US.prepare(
    `SELECT id
     FROM canonical_memory_operations
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`,
  ).bind(tenantId, operationId).first()

  if (!row) {
    throw new Error(`canonical_projection_dispatch missing canonical operation ${operationId}`)
  }
}
