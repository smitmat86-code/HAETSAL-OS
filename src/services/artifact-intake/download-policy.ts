import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'

function ipv4Octets(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number(part))
  if (octets.some((part, index) => !/^\d{1,3}$/.test(parts[index] ?? '') || part < 0 || part > 255)) return null
  return octets
}

function isBlockedIpv4(value: string): boolean {
  const octets = ipv4Octets(value)
  if (!octets) return false
  const [a, b] = octets
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  )
}

function isBlockedIpv6(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (!address.includes(':')) return false
  return (
    address === '::' || address === '::1' ||
    address.startsWith('fc') || address.startsWith('fd') ||
    /^fe[89ab]/.test(address) || address.startsWith('ff') ||
    address.startsWith('2001:db8:') ||
    address.startsWith('::ffff:127.') || address.startsWith('::ffff:10.') ||
    address.startsWith('::ffff:169.254.') || address.startsWith('::ffff:192.168.')
  )
}

export function isBlockedArtifactAddress(value: string): boolean {
  return isBlockedIpv4(value) || isBlockedIpv6(value)
}

export function assertArtifactResolvedAddressAllowed(address: string): void {
  if (isBlockedArtifactAddress(address)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
}

/**
 * Validates the URL before any fetch. Session 4 must additionally resolve and
 * pin a public address, then repeat URL and address validation on redirects.
 */
export function validateInitialArtifactDownloadUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    url.protocol !== 'https:' || url.username || url.password || !hostname ||
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    !hostname.includes('.') || isBlockedArtifactAddress(hostname)
  ) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
  return url
}
