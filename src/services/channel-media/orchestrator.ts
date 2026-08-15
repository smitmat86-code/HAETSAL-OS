import type { Env } from '../../types/env'
import type { ChannelMediaDescriptor } from '../../types/channel-media'
import { describeInboundPhoto } from '../messaging-helpers'
import { CHANNEL_MEDIA_MAX_ATTEMPTS } from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { acquireChannelMedia } from './providers'
import { readChannelMediaHandoff } from './handoff'
import {
  ensurePreparedChannelMediaUpload,
  finalizePreparedChannelMediaJob,
  prepareChannelMediaCapture,
} from './finalize-job'
import { recoverFinalizedChannelMediaJob } from './canonical-recovery'
import {
  cleanupChannelMediaHandoff,
  defaultChannelMediaDeliver,
  deliverChannelMediaClaim,
} from './delivery'
import { getChannelMediaJob } from './jobs'
import { claimChannelMediaJobForProcessing } from './claim-outcome'
import {
  markChannelMediaFailed,
  markChannelMediaRetryable,
  renewChannelMediaLease,
} from './job-transitions'
import { markChannelMediaDeliveryUnknown } from './delivery-state'
import { readChannelMediaRecovery } from './recovery'
import {
  channelMediaErrorCode as errorCode,
  deliverChannelMediaSuccess as deliverSuccess,
  handleExpiredChannelMediaJob,
  handleTerminalChannelMediaJob,
  PERMANENT_CHANNEL_MEDIA_ERRORS as PERMANENT_ERRORS,
  type ChannelMediaProcessResult,
  type ProcessChannelMediaJobArgs,
} from './orchestrator-support'

export type { ChannelMediaOrchestratorDependencies } from './orchestrator-support'
export async function processChannelMediaJob(args: ProcessChannelMediaJobArgs): Promise<ChannelMediaProcessResult> {
  const claim = await claimChannelMediaJobForProcessing(args.tenantId, args.operationId, args.env)
  if (!claim || claim.status === 'lease_held') return claim ?? 'ignored'
  const job = claim
  const deliver = args.dependencies?.deliver ?? defaultChannelMediaDeliver

  if (job.status === 'finalized' || job.status === 'failed') {
    return handleTerminalChannelMediaJob({ job, kek: args.kek, env: args.env, deliver })
  }

  const leaseToken = job.leaseToken
  if (!leaseToken) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)

  // The canonical store is authoritative. Repair a completed capture before
  // decrypting a locator, fetching provider bytes, or invoking vision.
  if (await recoverFinalizedChannelMediaJob(job, leaseToken, args.env)) {
    try {
      const descriptor = await readChannelMediaHandoff({
        tenantId: job.tenantId, operationId: job.id, kek: args.kek,
      }, args.env)
      return deliverSuccess({ tenantId: job.tenantId, operationId: job.id, descriptor, env: args.env, deliver })
    } catch (error) {
      if (errorCode(error) === ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED) throw error
      await markChannelMediaDeliveryUnknown(job.tenantId, job.id, args.env)
      return 'processed'
    }
  }

  if (job.expiresAt <= Date.now()) return handleExpiredChannelMediaJob({
    job, leaseToken, kek: args.kek, env: args.env, deliver,
  })

  let descriptor: ChannelMediaDescriptor
  try {
    descriptor = await readChannelMediaHandoff({
      tenantId: job.tenantId, operationId: job.id, kek: args.kek,
    }, args.env)
    if (descriptor.provider !== job.provider) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH)
    }
  } catch (error) {
    const code = errorCode(error)
    const terminal = PERMANENT_ERRORS.has(code) || job.attemptCount >= CHANNEL_MEDIA_MAX_ATTEMPTS
    if (terminal) {
      await markChannelMediaFailed(job.tenantId, job.id, leaseToken, code, args.env)
      await cleanupChannelMediaHandoff(job, args.env)
      return 'terminal_failed'
    }
    await markChannelMediaRetryable(job.tenantId, job.id, leaseToken, code, args.env)
    throw error
  }

  try {
    const acquire = args.dependencies?.acquire ?? acquireChannelMedia
    const describe = args.dependencies?.describe ?? describeInboundPhoto
    let prepared = await readChannelMediaRecovery({
      tenantId: job.tenantId, operationId: job.id, tmk: args.tmk,
    }, args.env)
    if (prepared) {
      try {
        await ensurePreparedChannelMediaUpload({ job, prepared, tmk: args.tmk, env: args.env })
      } catch (error) {
        if (errorCode(error) !== ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE) throw error
        const acquired = await acquire(descriptor, args.env)
        await renewChannelMediaLease(job.tenantId, job.id, leaseToken, args.env)
        await ensurePreparedChannelMediaUpload({ job, prepared, acquired, tmk: args.tmk, env: args.env })
      }
    } else {
      const acquired = await acquire(descriptor, args.env)
      const owned = acquired.bytes.slice().buffer as ArrayBuffer
      const description = await describe(args.env, owned, acquired.detectedMimeType)
      await renewChannelMediaLease(job.tenantId, job.id, leaseToken, args.env)
      prepared = await prepareChannelMediaCapture({
        job, acquired, description, tmk: args.tmk, env: args.env,
      })
    }
    await finalizePreparedChannelMediaJob({
      job, descriptor, prepared, leaseToken, tmk: args.tmk, env: args.env,
      afterCanonicalFinalization: args.dependencies?.afterCanonicalFinalization,
    })
    return deliverSuccess({ tenantId: job.tenantId, operationId: job.id, descriptor, env: args.env, deliver })
  } catch (error) {
    const code = errorCode(error)
    if (code === ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED) throw error
    if (code === ARTIFACT_INTAKE_ERROR.LEASE_LOST) throw error

    // A failure after canonical commit is success recovery, never a failed job
    // and never a false failure response.
    if (await recoverFinalizedChannelMediaJob(job, leaseToken, args.env)) {
      return deliverSuccess({ tenantId: job.tenantId, operationId: job.id, descriptor, env: args.env, deliver })
    }

    const terminal = PERMANENT_ERRORS.has(code) || job.attemptCount >= CHANNEL_MEDIA_MAX_ATTEMPTS
    if (!terminal) {
      await markChannelMediaRetryable(job.tenantId, job.id, leaseToken, code, args.env)
      console.warn('CHANNEL_MEDIA_RETRYABLE_FAILURE', { code })
      throw new ArtifactIntakeContractError(code as never)
    }
    await markChannelMediaFailed(job.tenantId, job.id, leaseToken, code, args.env)
    const failed = await getChannelMediaJob(job.tenantId, job.id, args.env)
    if (!failed || failed.status !== 'failed') return 'ignored'
    const notice = await deliverChannelMediaClaim({
      job: failed, descriptor,
      message: 'I could not capture that photo. Please try sending it again.',
      env: args.env, deliver,
    })
    if (notice === 'retry') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
    console.warn('CHANNEL_MEDIA_TERMINAL_FAILURE', { code })
    return 'terminal_failed'
  }
}
