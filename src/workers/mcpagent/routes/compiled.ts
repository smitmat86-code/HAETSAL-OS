// src/workers/mcpagent/routes/compiled.ts
// Phase 10 compiled pages (CF Access): list, read (markdown w/ frontmatter),
// rebuild from canonical truth, delete (deregister). The Phase 11 dashboard
// renders these; the gate smoke drives them.

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import { deriveTmk } from '../../../middleware/auth'
import {
  deleteCompiledPage, listCompiledPages, rebuildCompiledPage, renderCompiledPage,
  type CompiledPageKind,
} from '../../../services/compiled/page'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

const KINDS = new Set<CompiledPageKind>(['person', 'project', 'topic'])
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

export const compiled = new Hono<{ Bindings: Env; Variables: Variables }>()

compiled.get('/', async (c) => c.json(await listCompiledPages(c.env, c.get('tenantId'))))

compiled.post('/:kind/:key/rebuild', async (c) => {
  const kind = c.req.param('kind') as CompiledPageKind
  const key = c.req.param('key')
  if (!KINDS.has(kind) || !KEY_RE.test(key)) return c.json({ error: 'invalid kind or key' }, 400)
  type RebuildBody = { name?: string; keywords?: string[] }
  const body = await c.req.json<RebuildBody>().catch(() => ({} as RebuildBody))
  const name = body.name?.trim()
  if (!name || name.length > 120) return c.json({ error: 'name required (1-120 chars)' }, 400)
  try {
    const tmk = await deriveTmk(c.get('jwtSub'), c.env.CF_ACCESS_AUD)
    const ref = await rebuildCompiledPage(c.env, tmk, c.get('tenantId'), {
      kind, key, name,
      keywords: Array.isArray(body.keywords) ? body.keywords.filter((k): k is string => typeof k === 'string').slice(0, 10) : undefined,
    })
    return c.json(ref, 201)
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 500)
  }
})

compiled.get('/:kind/:key', async (c) => {
  const kind = c.req.param('kind') as CompiledPageKind
  if (!KINDS.has(kind)) return c.json({ error: 'invalid kind' }, 400)
  const markdown = await renderCompiledPage(c.env, c.get('tenantId'), kind, c.req.param('key'))
  if (markdown === null) return c.json({ error: 'page not compiled yet' }, 404)
  return c.text(markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
})

compiled.delete('/:kind/:key', async (c) => {
  const removed = await deleteCompiledPage(c.env, c.get('tenantId'), c.req.param('kind'), c.req.param('key'))
  return c.json({ removed }, removed ? 200 : 404)
})
