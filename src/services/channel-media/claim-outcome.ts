import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import {
  CHANNEL_MEDIA_JOB_LEASE_MS,
  CHANNEL_MEDIA_QUEUE_RETRY_MAX_SECONDS,
  CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS,
} from '../artifact-intake/config'
import { expireChannelMediaDeliveryClaim } from './delivery-state'
import { claimChannelMediaJob, getChannelMediaJob } from './jobs'

export type ChannelMediaJobClaimOutcome =
  | { status: 'processing_acquired'; job: ChannelMediaJob }
  | { status: 'processing_lease_held'; retryAfterSeconds: number }
  | { status: 'delivery_claim_held'; retryAfterSeconds: number }
  | { status: 'actionable_retryable'; retryAfterSeconds: number }
  | { status: 'finalized_delivery_pending'; job: ChannelMediaJob }
  | { status: 'failed_delivery_pending'; job: ChannelMediaJob }
  | { status: 'completed_or_terminal'; job: ChannelMediaJob }

export function channelMediaRetrySeconds(boundary: number | null, now = Date.now()): number {
  const remainingSeconds = Math.ceil(Math.max(0, (boundary ?? now) - now) / 1000)
  return Math.min(
    CHANNEL_MEDIA_QUEUE_RETRY_MAX_SECONDS,
    Math.max(CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS, remainingSeconds),
  )
}

function deliveryBoundary(job: ChannelMediaJob): number {
  return job.leaseExpiresAt ?? (job.updatedAt + CHANNEL_MEDIA_JOB_LEASE_MS)
}

async function classifyCurrentJob(
  job: ChannelMediaJob,
  env: Env,
  now: number,
): Promise<ChannelMediaJobClaimOutcome | null> {
  if (job.deliveryStatus === 'claimed') {
    const boundary = deliveryBoundary(job)
    if (boundary > now) {
      return { status: 'delivery_claim_held', retryAfterSeconds: channelMediaRetrySeconds(boundary, now) }
    }
    await expireChannelMediaDeliveryClaim(job, env, now)
    return null
  }
  if (
    job.status === 'delivered' || job.status === 'delivery_unknown' ||
    job.deliveryStatus === 'delivered' || job.deliveryStatus === 'failed' ||
    job.deliveryStatus === 'unknown'
  ) return { status: 'completed_or_terminal', job }
  if (job.status === 'finalized' && job.deliveryStatus === 'pending') {
    return { status: 'finalized_delivery_pending', job }
  }
  if (job.status === 'failed' && job.deliveryStatus === 'pending') {
    return { status: 'failed_delivery_pending', job }
  }
  if (job.status === 'processing' && (job.leaseExpiresAt ?? 0) > now) {
    return {
      status: 'processing_lease_held',
      retryAfterSeconds: channelMediaRetrySeconds(job.leaseExpiresAt, now),
    }
  }
  return {
    status: 'actionable_retryable',
    retryAfterSeconds: CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS,
  }
}

export async function claimChannelMediaJobForProcessing(
  tenantId: string,
  operationId: string,
  env: Env,
): Promise<ChannelMediaJobClaimOutcome> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const job = await claimChannelMediaJob(tenantId, operationId, env)
    if (job) {
      if (job.status === 'processing') return { status: 'processing_acquired', job }
      if (job.status === 'finalized' && job.deliveryStatus === 'pending') {
        return { status: 'finalized_delivery_pending', job }
      }
      if (job.status === 'failed' && job.deliveryStatus === 'pending') {
        return { status: 'failed_delivery_pending', job }
      }
    }
    const current = await getChannelMediaJob(tenantId, operationId, env)
    if (!current) throw new Error('channel_media_job_not_found')
    const outcome = await classifyCurrentJob(current, env, Date.now())
    if (!outcome) continue
    if (outcome.status !== 'actionable_retryable' || attempt === 2) return outcome
  }
  const current = await getChannelMediaJob(tenantId, operationId, env)
  if (!current) throw new Error('channel_media_job_not_found')
  return {
    status: 'actionable_retryable',
    retryAfterSeconds: CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS,
  }
}
