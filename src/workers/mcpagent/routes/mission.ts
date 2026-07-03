// Mission Phase 3 admin surface (behind CF Access auth like every route).
// Drives the G7 Hindsight data export. Thin handlers; logic in
// services/mission-hindsight-export.ts. Removable after the mission.

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import {
  exportHindsightTable,
  finalizeHindsightExport,
  scanHindsightExport,
} from '../../../services/mission-hindsight-export'

export const mission = new Hono<{ Bindings: Env }>()

mission.post('/hindsight-export/scan', async (c) => {
  return c.json(await scanHindsightExport(c.env))
})

mission.post('/hindsight-export/table', async (c) => {
  const body = await c.req.json<{ exportId: string; tenantId: string; schema: string; table: string; offset: number }>()
  return c.json(await exportHindsightTable(body, c.env))
})

mission.post('/hindsight-export/finalize', async (c) => {
  const body = await c.req.json<Parameters<typeof finalizeHindsightExport>[0]>()
  return c.json(await finalizeHindsightExport(body, c.env))
})
