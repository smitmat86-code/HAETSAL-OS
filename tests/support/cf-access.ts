import { vi } from 'vitest'

const JWKS_URL = 'https://test-team.cloudflareaccess.com/cdn-cgi/access/certs'

interface CfAccessMockOptions {
  sub?: string
  aud?: string[]
  exp?: number
  type?: string
  common_name?: string
}

export async function installCfAccessMock(subOrOptions: string | CfAccessMockOptions): Promise<{
  jwt: string
  restore: () => void
}> {
  const options = typeof subOrOptions === 'string'
    ? { sub: subOrOptions }
    : subOrOptions
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair

  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey & {
    kid?: string
  }
  publicJwk.kid = 'test-kid'

  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' }))
  const payload = encodeBase64Url(JSON.stringify({
    sub: options.sub ?? '',
    aud: options.aud ?? ['test-aud-brain-access'],
    exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
    type: options.type,
    common_name: options.common_name,
  }))

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  )
  const jwt = `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`

  const originalFetch = globalThis.fetch.bind(globalThis)
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (url === JWKS_URL) {
      return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { 'Content-Type': 'application/json' },
      }))
    }

    return originalFetch(input, init)
  })

  return {
    jwt,
    restore: () => spy.mockRestore(),
  }
}

function encodeBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
