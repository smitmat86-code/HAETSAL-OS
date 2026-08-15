import { resolve4, resolve6 } from 'node:dns/promises'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { assertArtifactResolvedAddressAllowed, normalizeArtifactIpAddress } from './download-policy'
import type { ArtifactDownloadNetwork, ArtifactDownloadResponse } from './download-types'

async function resolveDefault(hostname: string): Promise<string[]> {
  const literal = normalizeArtifactIpAddress(hostname)
  if (literal) return [literal]
  const answers = await Promise.allSettled([resolve4(hostname), resolve6(hostname)])
  const addresses = answers.flatMap(answer => answer.status === 'fulfilled' ? answer.value : [])
  if (addresses.length === 0) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_UNAVAILABLE)
  }
  return addresses
}

function assertConnectionTimeAddressStable(addresses: string[], pinnedAddress: string): void {
  const pinned = normalizeArtifactIpAddress(pinnedAddress)
  const current = addresses
    .map(normalizeArtifactIpAddress)
    .filter((address): address is string => address !== null)
  for (const address of current) assertArtifactResolvedAddressAllowed(address)
  if (!pinned || !current.includes(pinned)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
}

async function resolveConnectionTime(
  hostname: string,
  pinnedAddress: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT)
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.DOWNLOAD_TIMEOUT))
    signal.addEventListener('abort', abort, { once: true })
    resolveDefault(hostname).then(
      addresses => {
        signal.removeEventListener('abort', abort)
        try { assertConnectionTimeAddressStable(addresses, pinnedAddress); resolve() } catch (error) { reject(error) }
      },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

async function requestIsolatedHttps(
  url: URL,
  pinnedAddress: string,
  signal: AbortSignal,
): Promise<ArtifactDownloadResponse> {
  await resolveConnectionTime(url.hostname, pinnedAddress, signal)
  const response = await fetch(url.href, {
    method: 'GET',
    headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
    redirect: 'manual',
    signal,
  })
  try {
    await resolveConnectionTime(url.hostname, pinnedAddress, signal)
  } catch (error) {
    await response.body?.cancel().catch(() => undefined)
    throw error
  }
  const cancel = () => { void response.body?.cancel().catch(() => undefined) }
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    remoteAddress: null,
    cancel,
  }
}

export const DEFAULT_ARTIFACT_DOWNLOAD_NETWORK: ArtifactDownloadNetwork = Object.freeze({
  connectionSafety: 'isolated_fetch',
  resolve: resolveDefault,
  request: requestIsolatedHttps,
})
