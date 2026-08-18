import type { Env } from '../../types/env'
import { CHANNEL_MEDIA_JOB_LEASE_MS } from '../artifact-intake/config'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { recoverFinalizedChannelMediaJob } from './canonical-recovery'
import { cleanupChannelMediaHandoff } from './delivery'
import { expireChannelMediaDeliveryClaim } from './delivery-state'
import { deleteChannelMediaHandoff } from './handoff'
import { claimChannelMediaJob, getChannelMediaJob } from './jobs'
import { markChannelMediaFailed, markChannelMediaIntegrityIncident } from './job-transitions'
import { deleteChannelMediaRecovery } from './recovery'

interface ExpiredRow {
  id: string
  tenant_id: string
  status: string
  delivery_status: string
  integrity_status: string | null
  error_code: string | null
  lease_expires_at: number | null
}

export async function reapExpiredChannelMediaJobs(
  env: Env,
  now = Date.now(),
  limit = 100,
): Promise<{ reaped: number }> {
  const rows = await env.D1_US.prepare(
    `SELECT id, tenant_id, status, delivery_status, integrity_status, error_code, lease_expires_at FROM channel_media_jobs
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
    // Integrity incidents are protected manual-review state, never reap fuel.
    // The legacy guard keeps skipping rows marked before migration 1034.
    if (row.integrity_status !== null && row.integrity_status !== undefined) continue
    if (
      row.status === 'delivery_unknown' && row.delivery_status === 'unknown' &&
      row.error_code === ARTIFACT_INTAKE_ERROR.INVALID_STATE
    ) continue

    if (row.delivery_status === 'pending') {
      const current = await getChannelMediaJob(row.tenant_id, row.id, env)
      if (!current) continue
      const recovery = await recoverFinalizedChannelMediaJob(current, env)
      if (recovery.status === 'recovered') {
        reaped += 1
        continue
      }
      if (recovery.status === 'in_progress') continue
      if (recovery.status === 'inconsistent' && recovery.protectedFinalizedHistory) {
        await markChannelMediaIntegrityIncident(row.tenant_id, row.id, env)
        continue
      }
      if (['accepted', 'retryable', 'processing'].includes(current.status)) {
        const claimed = await claimChannelMediaJob(row.tenant_id, row.id, env)
        if (!claimed || claimed.status !== 'processing' || !claimed.leaseToken) continue
        await markChannelMediaFailed(
          row.tenant_id, row.id, claimed.leaseToken,
          recovery.status === 'failed' || recovery.status === 'inconsistent'
            ? recovery.errorCode
            : ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED,
          env,
        )
      }
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
