import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import { CHANNEL_MEDIA_JOB_LEASE_MS } from '../artifact-intake/config'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sha256Text } from '../artifact-intake/crypto'

export interface ChannelMediaDeliveryClaim {
  leaseToken: string
  leaseExpiresAt: number
}

export async function claimChannelMediaDelivery(
  tenantId: string, operationId: string, env: Env,
): Promise<ChannelMediaDeliveryClaim | null> {
  const now = Date.now()
  const leaseToken = crypto.randomUUID()
  const leaseExpiresAt = now + CHANNEL_MEDIA_JOB_LEASE_MS
  const finalizationHash = await sha256Text(`channel-media-finalize:${operationId}`)
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET delivery_status = 'claimed', lease_token = ?,
       lease_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'pending'
       AND (status = 'finalized' OR (status = 'failed' AND NOT EXISTS (
         SELECT 1 FROM artifact_intake_finalizations
         WHERE tenant_id = ? AND idempotency_hash = ? AND status IN ('reserved', 'finalized')
       )))`,
  ).bind(
    leaseToken, leaseExpiresAt, now, tenantId, operationId, tenantId, finalizationHash,
  ).run()
  return Number(result.meta.changes ?? 0) === 1 ? { leaseToken, leaseExpiresAt } : null
}

export async function finishChannelMediaDelivery(args: {
  tenantId: string; operationId: string; leaseToken: string
  outcome: 'delivered' | 'rejected' | 'unknown'
}, env: Env): Promise<'finished' | 'expired' | 'lost'> {
  const now = Date.now()
  if (args.outcome === 'rejected') {
    const result = await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET delivery_status = 'pending', error_code = ?,
       lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'
         AND lease_token = ? AND lease_expires_at >= ?`,
    ).bind(
      ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED, now,
      args.tenantId, args.operationId, args.leaseToken, now,
    ).run()
    if (Number(result.meta.changes ?? 0) === 1) return 'finished'
    return await expireOwnedChannelMediaDeliveryClaim(args, env, now) ? 'expired' : 'lost'
  }
  const delivery = args.outcome === 'delivered' ? 'delivered' : 'unknown'
  const status = args.outcome === 'delivered' ? 'delivered' : 'delivery_unknown'
  const code = args.outcome === 'delivered' ? null : ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET delivery_status = ?,
       status = CASE WHEN status = 'failed' THEN 'failed' ELSE ? END,
       error_code = CASE WHEN status = 'failed' THEN error_code ELSE ? END,
       lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'
       AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(
    delivery, status, code, now, args.tenantId, args.operationId, args.leaseToken, now,
  ).run()
  if (Number(result.meta.changes ?? 0) === 1) return 'finished'
  return await expireOwnedChannelMediaDeliveryClaim(args, env, now) ? 'expired' : 'lost'
}

async function expireOwnedChannelMediaDeliveryClaim(
  args: { tenantId: string; operationId: string; leaseToken: string },
  env: Env,
  now: number,
): Promise<boolean> {
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET
       status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'delivery_unknown' END,
       delivery_status = 'unknown',
       error_code = CASE WHEN status = 'failed' THEN error_code ELSE ? END,
       lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'
       AND lease_token = ? AND lease_expires_at < ?`,
  ).bind(
    ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN, now,
    args.tenantId, args.operationId, args.leaseToken, now,
  ).run()
  return Number(result.meta.changes ?? 0) === 1
}

export async function expireChannelMediaDeliveryClaim(
  job: ChannelMediaJob,
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  if (job.deliveryStatus !== 'claimed') return false
  if (job.leaseToken) {
    return expireOwnedChannelMediaDeliveryClaim({
      tenantId: job.tenantId, operationId: job.id, leaseToken: job.leaseToken,
    }, env, now)
  }
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET
       status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'delivery_unknown' END,
       delivery_status = 'unknown',
       error_code = CASE WHEN status = 'failed' THEN error_code ELSE ? END,
       lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'
       AND lease_token IS NULL AND updated_at = ?`,
  ).bind(
    ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN, now,
    job.tenantId, job.id, job.updatedAt,
  ).run()
  return Number(result.meta.changes ?? 0) === 1
}

export async function markChannelMediaDeliveryUnknown(
  tenantId: string, operationId: string, env: Env,
): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET
     status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'delivery_unknown' END,
     delivery_status = 'unknown',
     error_code = CASE WHEN status = 'failed' THEN error_code ELSE ? END,
     lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status IN ('finalized', 'failed')
       AND delivery_status = 'pending'`,
  ).bind(ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN, Date.now(), tenantId, operationId).run()
}
