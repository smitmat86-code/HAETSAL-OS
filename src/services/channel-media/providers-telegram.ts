import type { Env } from '../../types/env'
import type { AcquiredChannelMedia, ChannelMediaDescriptor } from '../../types/channel-media'
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS, TELEGRAM_ARTIFACT_MAX_BYTES } from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR, resolveArtifactMimeType } from '../artifact-intake/contracts'
import { readBoundedArtifactResponse } from '../artifact-intake/download-body'
import { detectArtifactMimeType } from '../artifact-intake/mime'

async function fetchBounded(url: string): Promise<{ bytes: Uint8Array; responseMimeType?: string }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, { signal: abort.signal, redirect: 'manual' })
    } catch {
      throw new ArtifactIntakeContractError(
        abort.signal.aborted ? ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT : ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE,
      )
    }
    if ([401, 403, 404, 410].includes(response.status)) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
    }
    if (!response.ok) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
    const bytes = await readBoundedArtifactResponse({
      status: response.status,
      headers: response.headers,
      body: response.body,
      remoteAddress: null,
      cancel: () => abort.abort(),
    }, TELEGRAM_ARTIFACT_MAX_BYTES)
    return { bytes, responseMimeType: response.headers.get('content-type')?.trim() || undefined }
  } finally {
    clearTimeout(timer)
  }
}

export async function acquireTelegramMedia(
  descriptor: ChannelMediaDescriptor,
  env: Env,
): Promise<AcquiredChannelMedia> {
  if (descriptor.locatorKind !== 'telegram_file_id') {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS)
  let parsed: { ok?: boolean; result?: { file_path?: string; file_size?: number } }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(descriptor.locator)}`,
      { signal: abort.signal, redirect: 'manual' },
    )
    if (!response.ok) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
    parsed = await response.json() as typeof parsed
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError) throw error
    throw new ArtifactIntakeContractError(
      abort.signal.aborted ? ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT : ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE,
    )
  } finally {
    clearTimeout(timer)
  }
  const path = parsed.result?.file_path
  if (
    parsed.ok !== true || !path || !/^[A-Za-z0-9_./-]{1,512}$/.test(path) ||
    path.includes('..') || path.startsWith('/') ||
    (typeof parsed.result?.file_size === 'number' && parsed.result.file_size > TELEGRAM_ARTIFACT_MAX_BYTES)
  ) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  const downloaded = await fetchBounded(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`)
  const detectedMimeType = detectArtifactMimeType(downloaded.bytes)
  const declared = downloaded.responseMimeType
  if (declared && declared !== 'application/octet-stream') {
    resolveArtifactMimeType({ declaredMimeType: declared, detectedMimeType })
  }
  if (!detectedMimeType.startsWith('image/')) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.UNSUPPORTED_MEDIA)
  }
  return { bytes: downloaded.bytes, detectedMimeType, declaredMimeType: declared }
}
