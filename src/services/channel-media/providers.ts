import type { Env } from '../../types/env'
import type { AcquiredChannelMedia, ChannelMediaDescriptor } from '../../types/channel-media'
import { acquireSendblueMedia } from './providers-sendblue'
import { acquireTelegramMedia } from './providers-telegram'

export { retrieveSendblueMediaUrl } from './providers-sendblue'

export async function acquireChannelMedia(
  descriptor: ChannelMediaDescriptor,
  env: Env,
): Promise<AcquiredChannelMedia> {
  return descriptor.provider === 'telegram'
    ? acquireTelegramMedia(descriptor, env)
    : acquireSendblueMedia(descriptor, env)
}
