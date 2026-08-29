import type { Env } from '../../types/env'
import type { ChannelMediaDescriptor, ChannelMediaProvider } from '../../types/channel-media'
import type { IngestionQueueMessage } from '../../types/ingestion'
import { fetchAndValidateKek } from '../../cron/kek'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { reserveChannelMediaJob } from './jobs'
import { validateChannelMediaDescriptor } from './descriptor'

export async function acceptChannelMedia(args: {
  tenantId: string
  provider: ChannelMediaProvider
  eventIdentity: string
  descriptor: ChannelMediaDescriptor
}, env: Env): Promise<{ operationId: string }> {
  const descriptor = validateChannelMediaDescriptor(args.descriptor)
  if (descriptor.provider !== args.provider) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  }
  const kek = await fetchAndValidateKek(args.tenantId, env)
  if (!kek) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE)
  const job = await reserveChannelMediaJob({ ...args, descriptor, kek }, env)
  if (job.deliveryStatus !== 'pending') return { operationId: job.id }
  const message: IngestionQueueMessage = {
    type: 'channel_media',
    tenantId: args.tenantId,
    payload: { operationId: job.id },
    enqueuedAt: Date.now(),
  }
  await env.QUEUE_HIGH.send(message)
  return { operationId: job.id }
}
