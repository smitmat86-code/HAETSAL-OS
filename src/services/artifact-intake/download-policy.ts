import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'

function ipv4Bytes(value: string): Uint8Array | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map(part => Number(part))
  if (bytes.some((part, index) => !/^\d{1,3}$/.test(parts[index] ?? '') || part < 0 || part > 255)) return null
  return Uint8Array.from(bytes)
}

function ipv6Bytes(value: string): Uint8Array | null {
  const unwrapped = value.replace(/^\[|\]$/g, '').split('%', 1)[0]!.toLowerCase()
  if (!unwrapped.includes(':')) return null
  const doubleColon = unwrapped.indexOf('::')
  if (doubleColon !== -1 && doubleColon !== unwrapped.lastIndexOf('::')) return null

  const expandSide = (side: string): number[] | null => {
    if (!side) return []
    const groups: number[] = []
    for (const part of side.split(':')) {
      if (part.includes('.')) {
        const embedded = ipv4Bytes(part)
        if (!embedded) return null
        groups.push((embedded[0]! << 8) | embedded[1]!, (embedded[2]! << 8) | embedded[3]!)
      } else {
        if (!/^[a-f0-9]{1,4}$/.test(part)) return null
        groups.push(Number.parseInt(part, 16))
      }
    }
    return groups
  }

  const left = expandSide(doubleColon === -1 ? unwrapped : unwrapped.slice(0, doubleColon))
  const right = expandSide(doubleColon === -1 ? '' : unwrapped.slice(doubleColon + 2))
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if ((doubleColon === -1 && missing !== 0) || (doubleColon !== -1 && missing < 1)) return null
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (groups.length !== 8) return null
  return Uint8Array.from(groups.flatMap(group => [group >> 8, group & 0xff]))
}

function prefixMatches(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8)
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  return (bytes[wholeBytes]! & mask) === ((prefix[wholeBytes] ?? 0) & mask)
}

const BLOCKED_IPV4: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16],
  [[172, 16], 12], [[192, 0, 0], 24], [[192, 0, 2], 24], [[192, 88, 99], 24],
  [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24],
  [[224], 4], [[240], 4],
]

const BLOCKED_IPV6: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96],
  [[0x00, 0x64, 0xff, 0x9b], 96], [[0x01, 0x00], 64],
  [[0x20, 0x01, 0x00, 0x00], 32], [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x20, 0x02], 16], [[0xfc], 7], [[0xfe, 0x80], 10], [[0xff], 8],
]

export function normalizeArtifactIpAddress(value: string): string | null {
  const ipv4 = ipv4Bytes(value)
  if (ipv4) return Array.from(ipv4).join('.')
  const ipv6 = ipv6Bytes(value)
  if (!ipv6) return null
  return Array.from({ length: 8 }, (_, index) =>
    ((ipv6[index * 2]! << 8) | ipv6[index * 2 + 1]!).toString(16),
  ).join(':')
}

export function isBlockedArtifactAddress(value: string): boolean {
  const ipv4 = ipv4Bytes(value)
  if (ipv4) return BLOCKED_IPV4.some(([prefix, bits]) => prefixMatches(ipv4, prefix, bits))
  const ipv6 = ipv6Bytes(value)
  if (ipv6) return BLOCKED_IPV6.some(([prefix, bits]) => prefixMatches(ipv6, prefix, bits))
  return false
}

export function assertArtifactResolvedAddressAllowed(address: string): void {
  if (!normalizeArtifactIpAddress(address) || isBlockedArtifactAddress(address)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
}

export function validateInitialArtifactDownloadUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const literalIp = normalizeArtifactIpAddress(hostname)
  if (
    url.protocol !== 'https:' || url.username || url.password || !hostname ||
    (url.port && url.port !== '443') ||
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') ||
    (!hostname.includes('.') && literalIp === null) ||
    (literalIp !== null && isBlockedArtifactAddress(hostname))
  ) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.SSRF_URL_BLOCKED)
  }
  url.hostname = hostname
  url.hash = ''
  return url
}
