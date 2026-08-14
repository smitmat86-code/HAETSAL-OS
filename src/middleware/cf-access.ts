export interface CfAccessJwtPayload {
  sub: string
  aud: string | string[]
  exp: number
  type?: string
  common_name?: string
}

export interface ResolvedAccessPrincipal {
  actorPrincipalId: string
  tenantPrincipalId: string
  delegated: boolean
}

export interface DelegatedClientIdentity { clientName: string; agentIdentity: string }

/** Resolve non-secret provenance labels for an authenticated service client. */
export function resolveDelegatedClientIdentity(
  payload: Pick<CfAccessJwtPayload, 'sub' | 'type' | 'common_name'>,
  clientIdentitiesJson?: string,
): DelegatedClientIdentity | null {
  const commonName = payload.common_name?.trim() ?? ''
  const isServiceToken = payload.type === 'app' && !payload.sub?.trim() && Boolean(commonName)
  if (!isServiceToken) return null
  if (!clientIdentitiesJson?.trim()) return null

  let configured: unknown
  try {
    configured = JSON.parse(clientIdentitiesJson)
  } catch {
    throw new Error('Invalid CF Access client identity configuration')
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('Invalid CF Access client identity configuration')
  }
  const value = (configured as Record<string, unknown>)[commonName]
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid CF Access client identity configuration')
  }
  const clientName = (value as Record<string, unknown>).client_name
  const agentIdentity = (value as Record<string, unknown>).agent_identity
  if (
    typeof clientName !== 'string' || !clientName.trim() || clientName.length > 120 ||
    typeof agentIdentity !== 'string' || !agentIdentity.trim() || agentIdentity.length > 160
  ) {
    throw new Error('Invalid CF Access client identity configuration')
  }
  return { clientName: clientName.trim(), agentIdentity: agentIdentity.trim() }
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

/**
 * Resolve the authenticated actor separately from the principal that owns the
 * tenant. Identity-authenticated users always resolve to themselves. A
 * Cloudflare Access service token may resolve to a human tenant only when its
 * exact client id (`common_name`) appears in the secret JSON allowlist.
 *
 * Unknown service tokens retain the existing isolated machine-tenant behavior.
 */
export function resolveAccessPrincipal(
  payload: Pick<CfAccessJwtPayload, 'sub' | 'type' | 'common_name'>,
  delegatedPrincipalsJson?: string,
): ResolvedAccessPrincipal {
  const actorPrincipalId = deriveAccessPrincipalId(payload)
  const commonName = payload.common_name?.trim() ?? ''
  const isServiceToken = payload.type === 'app' && !payload.sub?.trim() && Boolean(commonName)

  if (!isServiceToken || !delegatedPrincipalsJson?.trim()) {
    return { actorPrincipalId, tenantPrincipalId: actorPrincipalId, delegated: false }
  }

  let allowlist: unknown
  try {
    allowlist = JSON.parse(delegatedPrincipalsJson)
  } catch {
    throw new Error('Invalid CF Access service delegation configuration')
  }

  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) {
    throw new Error('Invalid CF Access service delegation configuration')
  }

  const entries = allowlist as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(entries, commonName)) {
    return { actorPrincipalId, tenantPrincipalId: actorPrincipalId, delegated: false }
  }

  const delegatedPrincipal = entries[commonName]
  if (typeof delegatedPrincipal !== 'string' || !delegatedPrincipal.trim()) {
    throw new Error('Invalid CF Access service delegation configuration')
  }

  return {
    actorPrincipalId,
    tenantPrincipalId: delegatedPrincipal.trim(),
    delegated: true,
  }
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
