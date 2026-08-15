import type { Env } from '../../types/env'
import type { AcquiredChannelMedia, ChannelMediaDescriptor } from '../../types/channel-media'
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS, ARTIFACT_MAX_BYTES } from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { downloadHostedArtifactFile } from '../artifact-intake/download'
import { sendblueAuthHeaders } from '../delivery/sendblue'

export async function retrieveSendblueMediaUrl(
  descriptor: ChannelMediaDescriptor,
  env: Env,
): Promise<string> {
  if (descriptor.locatorKind === 'sendblue_temporary_url') return descriptor.locator
  if (descriptor.locatorKind !== 'sendblue_message_handle') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(
      `https://api.sendblue.co/api/v2/messages/${encodeURIComponent(descriptor.locator)}`,
      { headers: sendblueAuthHeaders(env), signal: abort.signal, redirect: 'manual' },
    )
    if ([404, 410].includes(response.status)) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LOCATOR_EXPIRED)
    }
    if (!response.ok) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
    const payload = await response.json() as Record<string, unknown>
    const message = (
      payload.data && typeof payload.data === 'object' ? payload.data : payload
    ) as Record<string, unknown>
    if (message.message_handle !== descriptor.locator) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH)
    }
    const sender = typeof message.from_number === 'string' ? message.from_number : null
    if (sender && sender !== descriptor.replyTarget) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_RESPONSE_MISMATCH)
    }
    if (typeof message.media_url !== 'string' || !message.media_url) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
    }
    return message.media_url
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError) throw error
    throw new ArtifactIntakeContractError(
      abort.signal.aborted ? ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT : ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE,
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function acquireSendblueMedia(
  descriptor: ChannelMediaDescriptor,
  env: Env,
): Promise<AcquiredChannelMedia> {
  const mediaUrl = await retrieveSendblueMediaUrl(descriptor, env)
  const downloaded = await downloadHostedArtifactFile({
    download_url: mediaUrl,
    file_id: 'sendblue-provider-media',
  }, undefined, {
    maxBytes: ARTIFACT_MAX_BYTES,
    timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 3,
  })
  if (!downloaded.detectedMimeType.startsWith('image/')) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.UNSUPPORTED_MEDIA)
  }
  return {
    bytes: downloaded.bytes,
    detectedMimeType: downloaded.detectedMimeType,
    declaredMimeType: downloaded.declaredMimeType,
  }
}
