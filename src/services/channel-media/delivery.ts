import type { Env } from '../../types/env'
import type { ChannelMediaDescriptor, ChannelMediaJob } from '../../types/channel-media'
import { sendTelegramReply } from '../delivery/telegram'
import { sendSendblueMessage } from '../delivery/sendblue'
import { deleteChannelMediaHandoff } from './handoff'
import { deleteChannelMediaRecovery } from './recovery'
import { claimChannelMediaDelivery, finishChannelMediaDelivery } from './delivery-state'
import { channelMediaRetrySeconds } from './claim-outcome'
import { getChannelMediaJob } from './jobs'

export type ChannelMediaDeliveryOutcome = 'delivered' | 'rejected' | 'unknown'
export type ChannelMediaDeliver = (
  descriptor: ChannelMediaDescriptor, message: string, env: Env,
) => Promise<ChannelMediaDeliveryOutcome>

export async function defaultChannelMediaDeliver(
  descriptor: ChannelMediaDescriptor,
  message: string,
  env: Env,
): Promise<ChannelMediaDeliveryOutcome> {
  try {
    if (descriptor.provider === 'telegram') {
      return await sendTelegramReply(descriptor.replyTarget, message, env) ? 'delivered' : 'rejected'
    }
    const result = await sendSendblueMessage(descriptor.replyTarget, message, env)
    if (result.success) return 'delivered'
    return result.status === 0 ? 'unknown' : 'rejected'
  } catch {
    return 'unknown'
  }
}

export async function cleanupChannelMediaHandoff(job: ChannelMediaJob, env: Env): Promise<void> {
  try {
    await Promise.all([
      deleteChannelMediaHandoff(job.tenantId, job.id, env),
      deleteChannelMediaRecovery(job.tenantId, job.id, env),
    ])
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET handoff_status = 'deleted', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(Date.now(), job.tenantId, job.id).run()
  } catch {
    console.warn('CHANNEL_MEDIA_HANDOFF_CLEANUP_FAILED')
  }
}

export async function deliverChannelMediaClaim(args: {
  job: ChannelMediaJob
  descriptor: ChannelMediaDescriptor
  message: string
  env: Env
  deliver: ChannelMediaDeliver
}): Promise<'done' | 'retry' | { status: 'held'; retryAfterSeconds: number }> {
  const claim = await claimChannelMediaDelivery(args.job.tenantId, args.job.id, args.env)
  if (!claim) {
    const current = await getChannelMediaJob(args.job.tenantId, args.job.id, args.env)
    if (current?.deliveryStatus === 'claimed') {
      return {
        status: 'held',
        retryAfterSeconds: channelMediaRetrySeconds(current.leaseExpiresAt),
      }
    }
    if (current?.deliveryStatus === 'pending') return 'retry'
    return 'done'
  }
  const outcome = await args.deliver(args.descriptor, args.message, args.env)
  const completion = await finishChannelMediaDelivery({
    tenantId: args.job.tenantId, operationId: args.job.id,
    leaseToken: claim.leaseToken, outcome,
  }, args.env)
  if (outcome === 'rejected' && completion === 'finished') return 'retry'
  await cleanupChannelMediaHandoff(args.job, args.env)
  return 'done'
}
