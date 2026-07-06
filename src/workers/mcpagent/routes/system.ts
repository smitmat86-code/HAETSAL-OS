// src/workers/mcpagent/routes/system.ts
// Phase 14: System panel API (CF Access — the authenticated USER only; Law 3:
// no MCP/agent tool reaches these). Mounted under /api/system via the
// dashboard-data app. Errors map to honest statuses: KekUnavailable → 409
// (open / to refresh the session key), unknown key/version → 404, bad body → 400.

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import { buildSystemOverview } from '../../../services/system/overview'
import { setTaskEnabled } from '../../../services/system/tasks'
import {
  resetPromptOverride, rollbackPromptOverride, savePromptOverride,
} from '../../../services/prompts/overrides'
import { listPromptVersions } from '../../../services/prompts/override-history'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const system = new Hono<{ Bindings: Env; Variables: Variables }>()

const fail = (error: unknown): { message: string; status: 400 | 404 | 409 | 500 } => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('KekUnavailable')) return { message, status: 409 }
  if (message === 'PromptVersionNotFound') return { message, status: 404 }
  if (message === 'PromptNotEditable' || message === 'PromptBodyInvalid' || message === 'UnknownTask') {
    return { message, status: 400 }
  }
  return { message: message.slice(0, 160), status: 500 }
}

system.get('/overview', async (c) => {
  return c.json(await buildSystemOverview(c.env, c.get('tenantId')))
})

system.get('/prompts/:key/versions', async (c) => {
  try {
    return c.json(await listPromptVersions(c.env, c.get('tenantId'), c.req.param('key')))
  } catch (error) {
    const { message, status } = fail(error)
    return c.json({ error: message }, status)
  }
})

system.post('/prompts/:key', async (c) => {
  const { body } = await c.req.json<{ body?: string }>().catch(() => ({ body: undefined }))
  if (typeof body !== 'string') return c.json({ error: 'Missing body' }, 400)
  try {
    return c.json(await savePromptOverride(c.env, c.get('tenantId'), c.req.param('key'), body))
  } catch (error) {
    const { message, status } = fail(error)
    return c.json({ error: message }, status)
  }
})

system.post('/prompts/:key/rollback', async (c) => {
  const { version } = await c.req.json<{ version?: number }>().catch(() => ({ version: undefined }))
  if (typeof version !== 'number') return c.json({ error: 'Missing version' }, 400)
  try {
    await rollbackPromptOverride(c.env, c.get('tenantId'), c.req.param('key'), version)
    return c.json({ ok: true, version })
  } catch (error) {
    const { message, status } = fail(error)
    return c.json({ error: message }, status)
  }
})

system.delete('/prompts/:key', async (c) => {
  try {
    await resetPromptOverride(c.env, c.get('tenantId'), c.req.param('key'))
    return c.json({ ok: true, source: 'default' })
  } catch (error) {
    const { message, status } = fail(error)
    return c.json({ error: message }, status)
  }
})

system.post('/tasks/:name', async (c) => {
  const { enabled } = await c.req.json<{ enabled?: boolean }>().catch(() => ({ enabled: undefined }))
  if (typeof enabled !== 'boolean') return c.json({ error: 'Missing enabled' }, 400)
  try {
    await setTaskEnabled(c.env, c.get('tenantId'), c.req.param('name'), enabled)
    return c.json({ ok: true, enabled })
  } catch (error) {
    const { message, status } = fail(error)
    return c.json({ error: message }, status)
  }
})
