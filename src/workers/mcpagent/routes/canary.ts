import { Hono } from 'hono'
import type { Env } from '../../../types/env'

export const canary = new Hono<{ Bindings: Env }>()

export function hasCanonicalHyperdriveBinding(env: Env): boolean {
  return Boolean(env.HYPERDRIVE_CANONICAL?.connectionString?.trim())
}

canary.use('/hyperdrive', (c) => {
  if (c.req.method !== 'HEAD') return c.notFound()
  const status = hasCanonicalHyperdriveBinding(c.env) ? 204 : 503
  return c.body(null, status, { 'Cache-Control': 'no-store' })
})
