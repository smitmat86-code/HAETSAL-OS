import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import {
  CHANNEL_MEDIA_QUEUE_RETRY_MAX_SECONDS,
  CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS,
} from '../artifact-intake/config'
import { claimChannelMediaJob, getChannelMediaJob } from './jobs'

export type ChannelMediaJobClaim =
  | ChannelMediaJob
  | { status: 'lease_held'; retryAfterSeconds: number }
  | null

function leaseRetrySeconds(leaseExpiresAt: number | null, now = Date.now()): number {
  const remainingSeconds = Math.ceil(Math.max(0, (leaseExpiresAt ?? now) - now) / 1000)
  return Math.min(
    CHANNEL_MEDIA_QUEUE_RETRY_MAX_SECONDS,
    Math.max(CHANNEL_MEDIA_QUEUE_RETRY_MIN_SECONDS, remainingSeconds),
  )
}

export async function claimChannelMediaJobForProcessing(
  tenantId: string,
  operationId: string,
  env: Env,
): Promise<ChannelMediaJobClaim> {
  const job = await claimChannelMediaJob(tenantId, operationId, env)
  if (job) return job
  const current = await getChannelMediaJob(tenantId, operationId, env)
  return current?.status === 'processing'
    ? { status: 'lease_held', retryAfterSeconds: leaseRetrySeconds(current.leaseExpiresAt) }
    : null
}
