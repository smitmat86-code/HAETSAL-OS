import { Hono } from 'hono'
import {
  readTenantSettings,
  upsertTenantPreference,
} from '../../../services/action/preferences'
import { getOrCreateTenant } from '../../../services/tenant'
import type { Env } from '../../../types/env'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const settings = new Hono<{ Bindings: Env; Variables: Variables }>()

settings.get('/', async (c) => {
  await getOrCreateTenant(c.get('tenantId'), c.get('jwtSub'), c.env)
  try {
    const snapshot = await readTenantSettings(c.get('tenantId'), c.env)
    return c.json(snapshot)
  } catch (error) {
    if (error instanceof Error && error.message === 'TENANT_NOT_FOUND') {
      return c.json({ error: 'Tenant not found' }, 404)
    }
    throw error
  }
})

settings.post('/preferences', async (c) => {
  await getOrCreateTenant(c.get('tenantId'), c.get('jwtSub'), c.env)
  const body = await c.req.json<{
    capability_class?: string
    authorization_level?: string
    integration?: string | null
  }>()

  if (!body.capability_class || !body.authorization_level) {
    return c.json({ error: 'Missing capability_class or authorization_level' }, 400)
  }

  try {
    const preference = await upsertTenantPreference(
      c.get('tenantId'),
      c.get('jwtSub'),
      {
        capability_class: body.capability_class as never,
        authorization_level: body.authorization_level as never,
        integration: body.integration,
      },
      c.env,
    )
    return c.json(preference)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (error.message === 'INTEGRATION_NOT_SUPPORTED') {
      return c.json({ error: 'Integration-specific preferences are not supported in Phase 1.4' }, 400)
    }
    if (error.message === 'BELOW_HARD_FLOOR') {
      return c.json({ error: 'Authorization level cannot be lowered below the hard floor' }, 409)
    }
    if (error.message === 'TENANT_NOT_FOUND') {
      return c.json({ error: 'Tenant not found' }, 404)
    }
    throw error
  }
})
