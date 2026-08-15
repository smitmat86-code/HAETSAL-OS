import type { Env } from '../../types/env'
import { CHANNEL_MEDIA_JOB_LEASE_MS } from '../artifact-intake/config'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { recoverFinalizedChannelMediaJob } from './canonical-recovery'
import { cleanupChannelMediaHandoff } from './delivery'
import { expireChannelMediaDeliveryClaim } from './delivery-state'
import { deleteChannelMediaHandoff } from './handoff'
import { claimChannelMediaJob, getChannelMediaJob } from './jobs'
import { markChannelMediaFailed } from './job-transitions'
import { deleteChannelMediaRecovery } from './recovery'

interface ExpiredRow {
  id: string
  tenant_id: string
  status: string
  delivery_status: string
  lease_expires_at: number | null
}

export async function reapExpiredChannelMediaJobs(
  env: Env,
  now = Date.now(),
  limit = 100,
): Promise<{ reaped: number }> {
  const rows = await env.D1_US.prepare(
    `SELECT id, tenant_id, status, delivery_status, lease_expires_at FROM channel_media_jobs
     WHERE expires_at <= ? AND handoff_status = 'pending'
     ORDER BY expires_at ASC LIMIT ?`,
  ).bind(now, limit).all<ExpiredRow>()
  let reaped = 0
  for (const row of rows.results) {
    if (row.delivery_status === 'claimed') {
      const claimedDelivery = await getChannelMediaJob(row.tenant_id, row.id, env)
      if (!claimedDelivery) continue
      const boundary = claimedDelivery.leaseExpiresAt ??
        (claimedDelivery.updatedAt + CHANNEL_MEDIA_JOB_LEASE_MS)
      if (boundary > Date.now()) continue
      if (await expireChannelMediaDeliveryClaim(claimedDelivery, env)) {
        await cleanupChannelMediaHandoff(claimedDelivery, env)
        reaped += 1
      }
      continue
    }
    if (
      row.status === 'processing' && row.lease_expires_at !== null &&
      Number(row.lease_expires_at) > Date.now()
    ) continue

    if (
      row.delivery_status === 'pending' &&
      ['accepted', 'retryable', 'processing'].includes(row.status)
    ) {
      const claimed = await claimChannelMediaJob(row.tenant_id, row.id, env)
      if (!claimed || claimed.status !== 'processing' || !claimed.leaseToken) continue
      const recovery = await recoverFinalizedChannelMediaJob(claimed, env)
      if (recovery.status === 'recovered') {
        reaped += 1
        continue
      }
      if (recovery.status === 'in_progress') continue
      await markChannelMediaFailed(
        row.tenant_id, row.id, claimed.leaseToken,
        recovery.status === 'failed' || recovery.status === 'inconsistent'
          ? recovery.errorCode
          : ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED,
        env,
      )
    }

    await Promise.all([
      deleteChannelMediaHandoff(row.tenant_id, row.id, env),
      deleteChannelMediaRecovery(row.tenant_id, row.id, env),
    ])
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET handoff_status = 'deleted', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(now, row.tenant_id, row.id).run()
    const current = await getChannelMediaJob(row.tenant_id, row.id, env)
    if (current?.status === 'finalized' && current.deliveryStatus === 'pending') {
      await env.D1_US.prepare(
        `UPDATE channel_media_jobs SET delivery_status = 'failed', error_code = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'finalized'`,
      ).bind(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED, now, row.tenant_id, row.id).run()
    } else if (
      current?.deliveryStatus === 'pending' &&
      !['delivered', 'delivery_unknown'].includes(current.status)
    ) {
      await env.D1_US.prepare(
        `UPDATE channel_media_jobs SET status = 'failed', delivery_status = 'failed',
         error_code = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status != 'delivered'`,
      ).bind(ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED, now, row.tenant_id, row.id).run()
    }
    reaped += 1
  }
  return { reaped }
}
