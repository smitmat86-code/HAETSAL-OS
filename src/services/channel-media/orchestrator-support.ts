import type { Env } from '../../types/env'
import type { AcquiredChannelMedia, ChannelMediaDescriptor, ChannelMediaJob } from '../../types/channel-media'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { deliverChannelMediaClaim, type ChannelMediaDeliver } from './delivery'
import { getChannelMediaJob } from './jobs'
import { readChannelMediaHandoff } from './handoff'
import { markChannelMediaDeliveryUnknown } from './delivery-state'

export interface ChannelMediaOrchestratorDependencies {
  acquire?: (descriptor: ChannelMediaDescriptor, env: Env) => Promise<AcquiredChannelMedia>
  describe?: (env: Env, bytes: ArrayBuffer, mediaType: string) => Promise<string>
  deliver?: ChannelMediaDeliver
  afterCanonicalFinalization?: () => void | Promise<void>
}

export const PERMANENT_CHANNEL_MEDIA_ERRORS = new Set<string>([
  ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID,
  ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH,
  ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED,
  ARTIFACT_INTAKE_ERROR.MIME_MISMATCH,
  ARTIFACT_INTAKE_ERROR.BULK_IMPORT_REQUIRED,
  ARTIFACT_INTAKE_ERROR.UNSUPPORTED_MEDIA,
  ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE,
])

export function channelMediaErrorCode(error: unknown): string {
  return error instanceof ArtifactIntakeContractError
    ? error.code
    : ARTIFACT_INTAKE_ERROR.INVALID_STATE
}

export async function deliverChannelMediaSuccess(args: {
  tenantId: string
  operationId: string
  descriptor: ChannelMediaDescriptor
  env: Env
  deliver: ChannelMediaDeliver
}): Promise<'processed'> {
  const current = await getChannelMediaJob(args.tenantId, args.operationId, args.env)
  if (!current || (current.status !== 'finalized' && current.status !== 'delivered')) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const outcome = await deliverChannelMediaClaim({
    job: current, descriptor: args.descriptor, message: 'Captured that photo.',
    env: args.env, deliver: args.deliver,
  })
  if (outcome === 'retry') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
  }
  return 'processed'
}

export async function handleTerminalChannelMediaJob(args: {
  job: ChannelMediaJob; kek: CryptoKey; env: Env; deliver: ChannelMediaDeliver
}): Promise<'processed' | 'terminal_failed'> {
  let descriptor: ChannelMediaDescriptor
  try {
    descriptor = await readChannelMediaHandoff({
      tenantId: args.job.tenantId, operationId: args.job.id, kek: args.kek,
    }, args.env)
  } catch {
    if (args.job.status === 'finalized') {
      await markChannelMediaDeliveryUnknown(args.job.tenantId, args.job.id, args.env)
      return 'processed'
    }
    return 'terminal_failed'
  }
  if (args.job.status === 'finalized') {
    return deliverChannelMediaSuccess({
      tenantId: args.job.tenantId, operationId: args.job.id, descriptor,
      env: args.env, deliver: args.deliver,
    })
  }
  const outcome = await deliverChannelMediaClaim({
    job: args.job, descriptor,
    message: 'I could not capture that photo. Please try sending it again.',
    env: args.env, deliver: args.deliver,
  })
  if (outcome === 'retry') throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DELIVERY_REJECTED)
  return 'terminal_failed'
}
