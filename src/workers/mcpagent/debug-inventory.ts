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
import { runGoogleSourceEvidenceSync } from '../../services/google-source-sync'

export async function renderMemoryInventory(
  c: Context<{ Bindings: Env; Variables: { tenantId: string; jwtSub: string; traceId: string } }>,
): Promise<Response> {
  const tenantId = c.get('tenantId')
  const proof = c.req.query('proof') === '1'
  const sourceSync = proof
    ? await runGoogleSourceEvidenceSync({
      env: c.env,
      tenantId,
      jwtSub: c.get('jwtSub'),
      ctx: c.executionCtx,
    })
    : null
  const store = getCanonicalMemoryStore(c.env)
  const [stats, recent] = await Promise.all([
    store.getStats(tenantId),
    store.listRecentDocuments(tenantId, null, 20),
  ])

  const rows = recent.map((r) => `
    <tr>
      <td><code>${escape(r.capture_id.slice(0, 8))}&hellip;</code></td>
      <td>${escape(r.source_system ?? '')}</td>
      <td>${escape(r.title ?? '')}</td>
      <td>${new Date(r.captured_at).toISOString().replace('T', ' ').slice(0, 19)}Z</td>
    </tr>`).join('')
  const sourceRows = sourceSync?.evidence.map((item) => `
    <tr>
      <td>${escape(item.sourceSystem)}</td>
      <td><code>${escape(item.captureId.slice(0, 8))}&hellip;</code></td>
      <td>${escape(item.googleSource?.kind ?? '')}</td>
      <td>${escape(item.googleSource?.sourceId ?? '')}</td>
      <td>${escape(item.title ?? '')}</td>
      <td>${escape(item.chunkCount?.toString() ?? '')}</td>
      <td>${new Date(item.capturedAt).toISOString().replace('T', ' ').slice(0, 19)}Z</td>
    </tr>`).join('')
  const sourceSection = sourceSync ? `
<h2>Google source proof</h2>
<ul>
  <li><strong>Gmail:</strong> ${sourceSync.gmail.connected ? 'connected' : 'not connected'}, retained this run: ${sourceSync.gmail.retained}</li>
  <li><strong>Calendar:</strong> ${sourceSync.calendar.connected ? 'connected' : 'not connected'}, retained this run: ${sourceSync.calendar.retained}</li>
  <li><strong>Evidence rows:</strong> ${sourceSync.evidence.length}</li>
</ul>
<table><thead><tr><th>source</th><th>capture_id</th><th>kind</th><th>source_id</th><th>title</th><th>chunks</th><th>captured_at (UTC)</th></tr></thead>
<tbody>${sourceRows || '<tr><td colspan="7"><em>No Gmail or Calendar captures retained yet.</em></td></tr>'}</tbody></table>` : ''

  return c.html(`<!doctype html><html><head><title>HAETSAL memory inventory</title>
<style>body{font-family:system-ui;max-width:60rem;margin:2rem auto;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.9rem}
th{background:#f5f5f5}code{background:#eee;padding:0 .2rem}</style></head><body>
<h1>Canonical Postgres — inventory for <code>${escape(tenantId.slice(0, 8))}&hellip;</code></h1>
<p>Live query against Neon via Hyperdrive. Bodies are encrypted at rest and not shown here.</p>
<ul>
  <li><strong>Captures:</strong> ${escape(stats.captureCount.toString())}</li>
  <li><strong>Retrievable chunks (FTS):</strong> ${escape(stats.chunkCount.toString())}</li>
</ul>
<h2>20 most recent captures</h2>
<table><thead><tr><th>capture_id</th><th>source</th><th>title</th><th>captured_at (UTC)</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4"><em>None yet.</em></td></tr>'}</tbody></table>
${sourceSection}
</body></html>`)
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
