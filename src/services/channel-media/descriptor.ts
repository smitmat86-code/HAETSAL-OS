import type { ChannelMediaDescriptor } from '../../types/channel-media'
import {
  CHANNEL_MEDIA_CAPTION_MAX_CHARS,
  CHANNEL_MEDIA_HANDOFF_MAX_BYTES,
  CHANNEL_MEDIA_LOCATOR_MAX_CHARS,
  CHANNEL_MEDIA_REPLY_TARGET_MAX_CHARS,
} from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'

export function validateChannelMediaDescriptor(descriptor: Partial<ChannelMediaDescriptor>): ChannelMediaDescriptor {
  const locatorLimit = descriptor.locatorKind === 'sendblue_temporary_url'
    ? CHANNEL_MEDIA_LOCATOR_MAX_CHARS
    : 512
  const valid = descriptor.version === 1 &&
    (descriptor.provider === 'telegram' || descriptor.provider === 'sendblue') &&
    ['telegram_file_id', 'sendblue_message_handle', 'sendblue_temporary_url'].includes(descriptor.locatorKind ?? '') &&
    typeof descriptor.locator === 'string' && descriptor.locator.length > 0 && descriptor.locator.length <= locatorLimit &&
    typeof descriptor.replyTarget === 'string' && descriptor.replyTarget.length > 0 &&
    descriptor.replyTarget.length <= CHANNEL_MEDIA_REPLY_TARGET_MAX_CHARS &&
    (descriptor.caption === null || (
      typeof descriptor.caption === 'string' && descriptor.caption.length <= CHANNEL_MEDIA_CAPTION_MAX_CHARS
    )) &&
    typeof descriptor.occurredAt === 'number' && Number.isFinite(descriptor.occurredAt)
  if (!valid) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  if (new TextEncoder().encode(JSON.stringify(descriptor)).byteLength > CHANNEL_MEDIA_HANDOFF_MAX_BYTES) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  }
  return descriptor as ChannelMediaDescriptor
}
