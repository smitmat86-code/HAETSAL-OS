import { Hono } from 'hono'
import { getOrCreateTenant } from '../../../services/tenant'
import { getHindsightMemoryOpsSnapshot } from '../../../services/hindsight-ops'
import type { Env } from '../../../types/env'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

export const audit = new Hono<{ Bindings: Env; Variables: Variables }>()

audit.get('/', async (c) => {
  await getOrCreateTenant(c.get('tenantId'), c.get('jwtSub'), c.env)
  const tenantId = c.get('tenantId')
  const actionId = c.req.query('action_id') ?? null
  const limit = clampPositiveInt(c.req.query('limit'), actionId ? 100 : 20, 200)
  const offset = clampPositiveInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER)

  const rows = await c.env.D1_US.prepare(
    `SELECT aa.id, aa.action_id, aa.created_at, aa.event, aa.agent_identity, aa.detail_json,
            pa.action_type AS tool_name, pa.integration, pa.state, pa.result_summary
     FROM action_audit aa
     INNER JOIN pending_actions pa ON pa.id = aa.action_id
     WHERE aa.tenant_id = ?
       AND (? IS NULL OR aa.action_id = ?)
     ORDER BY aa.created_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(tenantId, actionId, actionId, limit, offset).all()

  const totalRow = await c.env.D1_US.prepare(
    `SELECT COUNT(*) AS total
     FROM action_audit
     WHERE tenant_id = ?
       AND (? IS NULL OR action_id = ?)`,
  ).bind(tenantId, actionId, actionId).first<{ total: number }>()

  return c.json({
    rows: rows.results,
    limit,
    offset,
    total: totalRow?.total ?? 0,
  })
})

audit.get('/memory', async (c) => {
  await getOrCreateTenant(c.get('tenantId'), c.get('jwtSub'), c.env)
  const tenantId = c.get('tenantId')
  const snapshot = await getHindsightMemoryOpsSnapshot(c.env, tenantId)
  return c.json(snapshot)
})

function clampPositiveInt(
  rawValue: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(rawValue ?? '', 10)
  if (Number.isNaN(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}
