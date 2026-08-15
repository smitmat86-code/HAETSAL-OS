import type { Env } from '../../types/env'
import type { AcquiredChannelMedia, ChannelMediaDescriptor } from '../../types/channel-media'
import { describeInboundPhoto } from '../messaging-helpers'
import { CHANNEL_MEDIA_MAX_ATTEMPTS } from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { acquireChannelMedia } from './providers'
import { readChannelMediaHandoff } from './handoff'
import { finalizeChannelMediaJob } from './finalize-job'
import {
  cleanupChannelMediaHandoff,
  defaultChannelMediaDeliver,
  deliverChannelMediaClaim,
  type ChannelMediaDeliver,
} from './delivery'
import {
  claimChannelMediaJob,
  markChannelMediaFailed,
  markChannelMediaRetryable,
} from './jobs'
import { markChannelMediaDeliveryUnknown } from './delivery-state'

export interface ChannelMediaOrchestratorDependencies {
  acquire?: (descriptor: ChannelMediaDescriptor, env: Env) => Promise<AcquiredChannelMedia>
  describe?: (env: Env, bytes: ArrayBuffer, mediaType: string) => Promise<string>
  deliver?: ChannelMediaDeliver
}

const PERMANENT_ERRORS = new Set<string>([
  ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID,
  ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH,
  ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED,
  ARTIFACT_INTAKE_ERROR.MIME_MISMATCH,
  ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED,
  ARTIFACT_INTAKE_ERROR.UNSUPPORTED_MEDIA,
  ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
])

function errorCode(error: unknown): string {
  return error instanceof ArtifactIntakeContractError
    ? error.code
    : ARTIFACT_INTAKE_ERROR.INVALID_STATE
}


export async function processChannelMediaJob(args: {
  tenantId: string
  operationId: string
  tmk: CryptoKey
  kek: CryptoKey
  env: Env
  dependencies?: ChannelMediaOrchestratorDependencies
}): Promise<'processed' | 'ignored' | 'terminal_failed'> {
  const job = await claimChannelMediaJob(args.tenantId, args.operationId, args.env)
  if (!job) return 'ignored'
  let descriptor: ChannelMediaDescriptor
  try {
    descriptor = await readChannelMediaHandoff({
      tenantId: args.tenantId, operationId: args.operationId, kek: args.kek,
    }, args.env)
    if (descriptor.provider !== job.provider) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH)
    }
  } catch (error) {
    const code = errorCode(error)
    if (job.status === 'finalized') {
      await markChannelMediaDeliveryUnknown(job.tenantId, job.id, args.env)
      return 'processed'
    }
    const terminal = PERMANENT_ERRORS.has(code) || job.attemptCount >= CHANNEL_MEDIA_MAX_ATTEMPTS
    if (terminal) {
      await markChannelMediaFailed(job.tenantId, job.id, code, args.env)
      await cleanupChannelMediaHandoff(job, args.env)
      return 'terminal_failed'
    }
    await markChannelMediaRetryable(job.tenantId, job.id, code, args.env)
    throw error
  }
  const deliver = args.dependencies?.deliver ?? defaultChannelMediaDeliver
  if (job.status === 'finalized') {
    const outcome = await deliverChannelMediaClaim({
      job, descriptor, message: 'Captured that photo.', env: args.env, deliver,
    })
    if (outcome === 'retry') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
    return 'processed'
  }
  if (job.status === 'failed') {
    const outcome = await deliverChannelMediaClaim({
      job, descriptor,
      message: 'I could not capture that photo. Please try sending it again.',
      env: args.env, deliver,
    })
    if (outcome === 'retry') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
    return 'terminal_failed'
  }
  try {
    const acquire = args.dependencies?.acquire ?? acquireChannelMedia
    const describe = args.dependencies?.describe ?? describeInboundPhoto
    const acquired = await acquire(descriptor, args.env)
    const owned = acquired.bytes.slice().buffer as ArrayBuffer
    const description = await describe(args.env, owned, acquired.detectedMimeType)
    await finalizeChannelMediaJob({ job, descriptor, acquired, description, tmk: args.tmk, env: args.env })
    const outcome = await deliverChannelMediaClaim({
      job: { ...job, status: 'finalized' }, descriptor,
      message: `Captured that photo: ${description}`, env: args.env, deliver,
    })
    if (outcome === 'retry') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
    return 'processed'
  } catch (error) {
    const code = errorCode(error)
    if (code === ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED) throw error
    const terminal = PERMANENT_ERRORS.has(code) || job.attemptCount >= CHANNEL_MEDIA_MAX_ATTEMPTS
    if (!terminal) {
      await markChannelMediaRetryable(job.tenantId, job.id, code, args.env)
      console.warn('CHANNEL_MEDIA_RETRYABLE_FAILURE', { code })
      throw new ArtifactIntakeContractError(code as never)
    }
    await markChannelMediaFailed(job.tenantId, job.id, code, args.env)
    const notice = await deliverChannelMediaClaim({
      job: { ...job, status: 'failed' }, descriptor,
      message: 'I could not capture that photo. Please try sending it again.',
      env: args.env, deliver,
    })
    if (notice === 'retry') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
    console.warn('CHANNEL_MEDIA_TERMINAL_FAILURE', { code })
    return 'terminal_failed'
  }
}
