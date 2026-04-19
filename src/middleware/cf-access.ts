export interface CfAccessJwtPayload {
  sub: string
  aud: string | string[]
  exp: number
  type?: string
  common_name?: string
}

export function deriveAccessPrincipalId(payload: Pick<CfAccessJwtPayload, 'sub' | 'type' | 'common_name'>): string {
  const sub = payload.sub?.trim() ?? ''
  if (sub) return sub

  const commonName = payload.common_name?.trim()
  if (payload.type === 'app' && commonName) {
    return `service:${commonName}`
  }

  throw new Error('CF Access JWT missing supported principal identity')
}

export async function validateCfAccessJwt(
  jwt: string,
  jwksUrl: string,
  expectedAud: string | string[],
): Promise<CfAccessJwtPayload> {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')

  const header = JSON.parse(atob(parts[0]))
  const payload = JSON.parse(atob(parts[1]))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired')
  }

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  const expected = Array.isArray(expectedAud) ? expectedAud : [expectedAud]
  if (!aud.some((value: string) => expected.includes(value))) throw new Error('Invalid audience')

  const jwksResponse = await fetch(jwksUrl)
  const jwks = await jwksResponse.json() as { keys: (JsonWebKey & { kid?: string })[] }
  const jwk = jwks.keys.find((key) => key.kid === header.kid)
  if (!jwk) throw new Error('No matching JWK found')

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  )

  const signature = Uint8Array.from(
    atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
    (char) => char.charCodeAt(0),
  )
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)
  if (!valid) throw new Error('Invalid JWT signature')

  return payload as CfAccessJwtPayload
}
