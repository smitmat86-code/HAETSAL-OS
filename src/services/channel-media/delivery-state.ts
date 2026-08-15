import type { Env } from '../../types/env'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'

export async function claimChannelMediaDelivery(
  tenantId: string, operationId: string, env: Env,
): Promise<boolean> {
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET delivery_status = 'claimed', updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'pending'
       AND status IN ('finalized', 'failed')`,
  ).bind(Date.now(), tenantId, operationId).run()
  return Number(result.meta.changes ?? 0) === 1
}

export async function finishChannelMediaDelivery(args: {
  tenantId: string; operationId: string; outcome: 'delivered' | 'rejected' | 'unknown'
}, env: Env): Promise<void> {
  if (args.outcome === 'rejected') {
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET delivery_status = 'pending', error_code = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'`,
    ).bind(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED, Date.now(), args.tenantId, args.operationId).run()
    return
  }
  const delivery = args.outcome === 'delivered' ? 'delivered' : 'unknown'
  const status = args.outcome === 'delivered' ? 'delivered' : 'delivery_unknown'
  const code = args.outcome === 'delivered' ? null : ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN
  await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET delivery_status = ?,
       status = CASE WHEN status = 'failed' THEN 'failed' ELSE ? END,
       error_code = CASE WHEN status = 'failed' THEN error_code ELSE ? END,
       updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'`,
  ).bind(delivery, status, code, Date.now(), args.tenantId, args.operationId).run()
}

export async function markChannelMediaDeliveryUnknown(
  tenantId: string, operationId: string, env: Env,
): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET status = 'delivery_unknown', delivery_status = 'unknown',
     error_code = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'finalized'`,
  ).bind(ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN, Date.now(), tenantId, operationId).run()
}
