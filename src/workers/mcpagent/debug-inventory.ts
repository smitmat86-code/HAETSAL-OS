// src/workers/mcpagent/debug-inventory.ts
// Diagnostic page: hit GET /debug/memory-inventory (behind CF Access) to see
// the actual canonical Postgres state for the caller's tenant — proof that
// captures land in retained memory, not agent-session state.
//
// Shows: capture count, chunk count, and the 20 most recent captures.
// Content bodies are NEVER surfaced (encrypted-at-rest; Law 2). Only
// metadata: source_system, provenance, captured_at, and title if present.

import type { Context } from 'hono'
import type { Env } from '../../types/env'
import { getCanonicalMemoryStore } from '../../services/canonical-postgres'
import { warmCanonicalPostgres } from '../../services/messaging-helpers'
import { createCanonicalPostgresSql } from '../../services/postgres-sql'

interface CountRow { n: string | number }

export async function renderMemoryInventory(
  c: Context<{ Bindings: Env; Variables: { tenantId: string; jwtSub: string; traceId: string } }>,
): Promise<Response> {
  const tenantId = c.get('tenantId')
  await warmCanonicalPostgres(c.env)
  const sql = createCanonicalPostgresSql(c.env)

  const [captureCountRow] = await sql<CountRow[]>`
    SELECT COUNT(*)::text AS n FROM canonical_captures WHERE tenant_id = ${tenantId}
  `
  const [chunkCountRow] = await sql<CountRow[]>`
    SELECT COUNT(*)::text AS n FROM chunk_text
    WHERE capture_id IN (SELECT id FROM canonical_captures WHERE tenant_id = ${tenantId})
  `

  const store = getCanonicalMemoryStore(c.env)
  const recent = await store.listRecentDocuments(tenantId, null, 20)

  const rows = recent.map((r) => `
    <tr>
      <td><code>${escape(r.capture_id.slice(0, 8))}&hellip;</code></td>
      <td>${escape(r.source_system ?? '')}</td>
      <td>${escape(r.title ?? '')}</td>
      <td>${new Date(r.captured_at).toISOString().replace('T', ' ').slice(0, 19)}Z</td>
    </tr>`).join('')

  return c.html(`<!doctype html><html><head><title>HAETSAL memory inventory</title>
<style>body{font-family:system-ui;max-width:60rem;margin:2rem auto;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.9rem}
th{background:#f5f5f5}code{background:#eee;padding:0 .2rem}</style></head><body>
<h1>Canonical Postgres — inventory for <code>${escape(tenantId.slice(0, 8))}&hellip;</code></h1>
<p>Live query against Neon via Hyperdrive. Bodies are encrypted at rest and not shown here.</p>
<ul>
  <li><strong>Captures:</strong> ${escape(captureCountRow?.n?.toString() ?? '?')}</li>
  <li><strong>Retrievable chunks (FTS):</strong> ${escape(chunkCountRow?.n?.toString() ?? '?')}</li>
</ul>
<h2>20 most recent captures</h2>
<table><thead><tr><th>capture_id</th><th>source</th><th>title</th><th>captured_at (UTC)</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4"><em>None yet.</em></td></tr>'}</tbody></table>
</body></html>`)
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
