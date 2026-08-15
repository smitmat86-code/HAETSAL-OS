import type { Env } from '../../types/env'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { deleteChannelMediaHandoff } from './handoff'
import { deleteChannelMediaRecovery } from './recovery'

interface ExpiredRow { id: string; tenant_id: string; status: string; delivery_status: string }

export async function reapExpiredChannelMediaJobs(
  env: Env,
  now = Date.now(),
  limit = 100,
): Promise<{ reaped: number }> {
  const rows = await env.D1_US.prepare(
    `SELECT id, tenant_id, status, delivery_status FROM channel_media_jobs
     WHERE expires_at <= ? AND handoff_status = 'pending'
     ORDER BY expires_at ASC LIMIT ?`,
  ).bind(now, limit).all<ExpiredRow>()
  let reaped = 0
  for (const row of rows.results) {
    await Promise.all([
      deleteChannelMediaHandoff(row.tenant_id, row.id, env),
      deleteChannelMediaRecovery(row.tenant_id, row.id, env),
    ])
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET handoff_status = 'deleted', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(now, row.tenant_id, row.id).run()
    if (row.status === 'finalized' && row.delivery_status === 'pending') {
      await env.D1_US.prepare(
        `UPDATE channel_media_jobs SET delivery_status = 'failed', error_code = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'finalized'`,
      ).bind(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED, now, row.tenant_id, row.id).run()
    } else if (row.delivery_status === 'pending' && !['delivered', 'delivery_unknown'].includes(row.status)) {
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
