import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  resolveArtifactMimeType,
} from './contracts'
import { readBoundedArtifactResponse } from './download-body'
import { DEFAULT_ARTIFACT_DOWNLOAD_NETWORK } from './download-network'
import {
  assertArtifactResolvedAddressAllowed,
  normalizeArtifactIpAddress,
  validateInitialArtifactDownloadUrl,
} from './download-policy'
import type {
  ArtifactDownloadLimits,
  ArtifactDownloadNetwork,
  ArtifactDownloadResponse,
  DownloadedArtifactFile,
  HostedArtifactFileDescriptor,
} from './download-types'
import { DEFAULT_ARTIFACT_DOWNLOAD_LIMITS } from './download-types'
import { detectArtifactMimeType } from './mime'

export * from './download-types'
export { DEFAULT_ARTIFACT_DOWNLOAD_NETWORK } from './download-network'

function normalizeAddressSet(addresses: string[]): string[] {
  const normalized = [...new Set(addresses
    .map(normalizeArtifactIpAddress)
    .filter((value): value is string => Boolean(value)))]
  if (normalized.length === 0) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
  }
  for (const address of normalized) assertArtifactResolvedAddressAllowed(address)
  return normalized.sort()
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

async function resolveForConnection(
  hostname: string,
  network: ArtifactDownloadNetwork,
  signal: AbortSignal,
): Promise<string> {
  const first = normalizeAddressSet(await abortable(network.resolve(hostname), signal))
  const connectionTime = normalizeAddressSet(await abortable(network.resolve(hostname), signal))
  const stable = connectionTime.find(address => first.includes(address))
  if (!stable) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  return stable
}

function assertPinnedResponse(response: ArtifactDownloadResponse, pinnedAddress: string): void {
  const connected = response.remoteAddress ? normalizeArtifactIpAddress(response.remoteAddress) : null
  if (!connected || connected !== normalizeArtifactIpAddress(pinnedAddress)) {
    response.cancel()
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
  assertArtifactResolvedAddressAllowed(connected)
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export async function downloadHostedArtifactFile(
  descriptor: HostedArtifactFileDescriptor,
  network: ArtifactDownloadNetwork = DEFAULT_ARTIFACT_DOWNLOAD_NETWORK,
  limits: ArtifactDownloadLimits = DEFAULT_ARTIFACT_DOWNLOAD_LIMITS,
): Promise<DownloadedArtifactFile> {
  let current = validateInitialArtifactDownloadUrl(descriptor.download_url)
  let timedOut = false
  const abort = new AbortController()
  const timer = setTimeout(() => { timedOut = true; abort.abort() }, limits.timeoutMs)

  try {
    for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
      const pinnedAddress = await resolveForConnection(current.hostname, network, abort.signal)
      let response: ArtifactDownloadResponse
      try {
        response = await network.request(current, pinnedAddress, abort.signal)
      } catch (error) {
        if (error instanceof ArtifactIntakeContractError) throw error
        const code = timedOut || abort.signal.aborted
          ? ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT
          : ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE
        throw new ArtifactIntakeContractError(code)
      }
      assertPinnedResponse(response, pinnedAddress)

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        response.cancel()
        if (!location || redirects === limits.maxRedirects) {
          throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
        }
        current = validateInitialArtifactDownloadUrl(new URL(location, current).href)
        continue
      }
      if ([401, 403, 404, 410].includes(response.status)) {
        response.cancel()
        throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
      }
      if (response.status < 200 || response.status >= 300) {
        response.cancel()
        throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
      }

      const bytes = await readBoundedArtifactResponse(response, limits.maxBytes)
      const detectedMimeType = detectArtifactMimeType(bytes)
      const responseMimeType = response.headers.get('content-type')?.trim() || undefined
      for (const declaredMimeType of [descriptor.mime_type, responseMimeType]) {
        if (declaredMimeType) resolveArtifactMimeType({ declaredMimeType, detectedMimeType })
      }
      return {
        bytes, detectedMimeType,
        declaredMimeType: descriptor.mime_type ?? responseMimeType,
        redirectCount: redirects,
      }
    }
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
  } catch (error) {
    if (timedOut || abort.signal.aborted) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
