// src/workers/mcpagent/routes/dashboard-data.ts
// Phase 11 dashboard data feeds (CF Access): memory search + graph, retrieval
// traces, usage summary (audit-derived operational counts — AI Gateway spend
// lives in the CF dashboard; Analytics Engine is write-only from Workers),
// and connection statuses (presence booleans only, never token material).

import { Hono } from 'hono'
import type { Env } from '../../../types/env'
import { deriveTmk } from '../../../middleware/auth'
import { listRecentCanonicalMemories, searchCanonicalMemory } from '../../../services/canonical-memory-query'
import { getCanonicalBrokerTrace, listRecentCanonicalBrokerTraces } from '../../../services/canonical-broker-trace-read'
import type { MemoryQueryMode } from '../../../types/canonical-memory-query'
import { getCanonicalMemoryStore } from '../../../services/canonical-postgres'
import { parseGoogleSourceReadAttribution } from '../../../services/google-source-read-contract'
import { system } from './system'

type Variables = { tenantId: string; jwtSub: string; traceId: string }

const MODES = new Set<MemoryQueryMode>(['raw', 'lexical', 'semantic', 'graph', 'temporal', 'compiled', 'composed'])

export const dashboardData = new Hono<{ Bindings: Env; Variables: Variables }>()

// Phase 14: System panel API (this app is mounted at /api → /api/system/*)
dashboardData.route('/system', system)

dashboardData.get('/memory/search', async (c) => {
  const tenantId = c.get('tenantId')
  const tmk = await deriveTmk(c.get('jwtSub'), c.env.CF_ACCESS_AUD)
  const query = c.req.query('q')?.trim()
  if (!query) {
    // Browser default view: most recent memories (no query yet).
    const recent = await listRecentCanonicalMemories({ tenantId, limit: 12 }, c.env, tenantId, { tmk })
    return c.json({ query: '', mode: 'recent', status: 'ok', items: recent.items })
  }
  const modeRaw = c.req.query('mode') as MemoryQueryMode | undefined
  const mode = modeRaw && MODES.has(modeRaw) ? modeRaw : 'composed'
  const result = await searchCanonicalMemory(
    { tenantId, query, mode, limit: 12 }, c.env, tenantId, { tmk },
  )
  return c.json(result)
})

dashboardData.get('/traces/recent', async (c) => {
  const tenantId = c.get('tenantId')
  const result = await listRecentCanonicalBrokerTraces({ tenantId, limit: 15 }, c.env, tenantId)
  return c.json(result)
})

dashboardData.get('/traces/:queryId', async (c) => {
  const tenantId = c.get('tenantId')
  try {
    return c.json(await getCanonicalBrokerTrace({ tenantId, queryId: c.req.param('queryId') }, c.env, tenantId))
  } catch (error) {
    return c.json({ error: (error instanceof Error ? error.message : String(error)).slice(0, 160) }, 404)
  }
})

dashboardData.get('/memory/source-evidence', async (c) => {
  const tenantId = c.get('tenantId')
  const limitRaw = Number(c.req.query('limit') ?? '20')
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 20, 1), 50)
  const store = getCanonicalMemoryStore(c.env)
  const rows = await store.listRecentDocuments(tenantId, null, Math.max(limit * 4, 20))
  const sourceRows = rows
    .filter((row) => row.source_system === 'gmail' || row.source_system === 'calendar')
    .slice(0, limit)
  const items = await Promise.all(sourceRows.map(async (row) => {
    const document = await store.getDocument(tenantId, row.document_id).catch(() => null)
    return {
      captureId: row.capture_id,
      documentId: row.document_id,
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
      googleSource: parseGoogleSourceReadAttribution({
        sourceSystem: row.source_system,
        sourceRef: row.source_ref,
      }),
      title: row.title,
      scope: row.scope,
      capturedAt: row.captured_at,
      chunkCount: document?.chunk_count ?? null,
    }
  }))
  return c.json({
    status: items.length > 0 ? 'ok' : 'empty',
    sourceSystems: [...new Set(items.map((item) => item.sourceSystem))].sort(),
    items,
  })
})

dashboardData.get('/usage/summary', async (c) => {
  const tenantId = c.get('tenantId')
  const since = Date.now() - 7 * 86_400_000
  const [operations, runs, automations] = await Promise.all([
    c.env.D1_US.prepare(
      `SELECT operation, COUNT(*) AS n FROM memory_audit
       WHERE tenant_id = ? AND created_at > ? GROUP BY operation ORDER BY n DESC LIMIT 20`,
    ).bind(tenantId, since).all<{ operation: string; n: number }>(),
    c.env.D1_US.prepare(
      `SELECT COUNT(*) AS n FROM memory_audit WHERE tenant_id = ? AND created_at > ? AND operation LIKE 'agent_run.%'`,
    ).bind(tenantId, since).first<{ n: number }>(),
    c.env.D1_US.prepare(
      `SELECT COUNT(*) AS n FROM memory_audit WHERE tenant_id = ? AND created_at > ? AND operation LIKE 'automation.%'`,
    ).bind(tenantId, since).first<{ n: number }>(),
  ])
  return c.json({
    windowDays: 7,
    operations: operations.results ?? [],
    agentRunEvents: runs?.n ?? 0,
    automationEvents: automations?.n ?? 0,
    note: 'Operational counts from the audit ledger. Model spend: Cloudflare dashboard → AI Gateway (haetsal-brain-gateway).',
  })
})

dashboardData.get('/connections', async (c) => {
  const tenantId = c.get('tenantId')
  const [google, telegram, phones] = await Promise.all([
    c.env.D1_US.prepare(
      'SELECT scope FROM google_oauth_tokens WHERE tenant_id = ?',
    ).bind(tenantId).all<{ scope: string }>().catch(() => ({ results: [] as Array<{ scope: string }> })),
    c.env.D1_US.prepare(
      'SELECT COUNT(*) AS n FROM telegram_chats WHERE tenant_id = ?',
    ).bind(tenantId).first<{ n: number }>().catch(() => null),
    c.env.D1_US.prepare(
      'SELECT COUNT(*) AS n FROM tenant_phone_numbers WHERE tenant_id = ?',
    ).bind(tenantId).first<{ n: number }>().catch(() => null),
  ])
  const googleScopes = (google.results ?? []).map(r => r.scope)
  return c.json({
    telegram: { connected: (telegram?.n ?? 0) > 0 },
    imessage_sms: { connected: (phones?.n ?? 0) > 0, line: 'Sendblue shared line + Telnyx' },
    google: {
      connected: googleScopes.length > 0,
      scopes: googleScopes,
      note: googleScopes.length === 0 ? 'Google OAuth not provisioned (see docs/lessons/phase-5-google-oauth-setup.md)' : undefined,
    },
    mcp: { connected: true, endpoint: '/mcp (CF Access)' },
  })
})
