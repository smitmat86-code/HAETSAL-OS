import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { deriveTenantId } from '../src/middleware/auth'
import { GOOGLE_OAUTH_SCOPES } from '../src/services/google/oauth'
import { installCfAccessMock } from './support/cf-access'

const TEST_AUD = 'test-aud-brain-access'

async function authorizedFetch(sub: string, path: string): Promise<Response> {
  const auth = await installCfAccessMock(sub)
  try {
    return await SELF.fetch(`http://localhost${path}`, {
      headers: { 'CF-Access-Jwt-Assertion': auth.jwt },
      redirect: 'manual',
    })
  } finally {
    auth.restore()
  }
}

describe('mission closeout — Google OAuth surface', () => {
  it('starts a state-bound offline consent flow with the mission scopes', async () => {
    const sub = `google-oauth-${crypto.randomUUID()}`
    const response = await authorizedFetch(sub, '/auth/google')
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_OAUTH_SCOPES)
    const state = location.searchParams.get('state')!
    const tenantId = await deriveTenantId(sub, TEST_AUD)
    expect(await env.KV_SESSION.get(`google_oauth_state:${tenantId}:${state}`)).toBe(sub)
  })

  it('rejects a callback with no matching state before exchanging a code', async () => {
    const response = await authorizedFetch(
      `google-oauth-invalid-${crypto.randomUUID()}`,
      '/auth/google/callback?code=fake&state=missing',
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid or expired OAuth state' })
  })
})
