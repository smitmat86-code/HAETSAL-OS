import type { Context } from 'hono'
import type { Env } from '../../../types/env'
import { runGoogleSourceEvidenceSync } from '../../../services/google-source-sync'

export async function renderGoogleSourceSync(
  c: Context<{ Bindings: Env; Variables: { tenantId: string; jwtSub: string; traceId: string } }>,
): Promise<Response> {
  const result = await runGoogleSourceEvidenceSync({
    env: c.env,
    tenantId: c.get('tenantId'),
    jwtSub: c.get('jwtSub'),
    ctx: c.executionCtx,
  })
  const rows = result.evidence.map((item) => `
    <tr>
      <td>${escape(item.sourceSystem)}</td>
      <td><code>${escape(item.captureId.slice(0, 8))}&hellip;</code></td>
      <td><code>${escape(item.documentId.slice(0, 8))}&hellip;</code></td>
      <td>${escape(item.googleSource?.kind ?? '')}</td>
      <td>${escape(item.googleSource?.sourceId ?? '')}</td>
      <td>${escape(item.title ?? '')}</td>
      <td>${escape(item.chunkCount?.toString() ?? '')}</td>
      <td>${new Date(item.capturedAt).toISOString().replace('T', ' ').slice(0, 19)}Z</td>
    </tr>`).join('')

  return c.html(`<!doctype html><html><head><title>HAETSAL Google source sync</title>
<style>body{font-family:system-ui;max-width:72rem;margin:2rem auto;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.9rem}
th{background:#f5f5f5}code{background:#eee;padding:0 .2rem}</style></head><body>
<h1>Google source sync evidence</h1>
<p>Read-only source sync. Bodies are retained encrypted and are not shown here.</p>
<ul>
  <li><strong>Gmail:</strong> ${result.gmail.connected ? 'connected' : 'not connected'}, retained this run: ${result.gmail.retained}</li>
  <li><strong>Calendar:</strong> ${result.calendar.connected ? 'connected' : 'not connected'}, retained this run: ${result.calendar.retained}</li>
  <li><strong>Evidence rows:</strong> ${result.evidence.length}</li>
</ul>
<table><thead><tr><th>source</th><th>capture_id</th><th>document_id</th><th>kind</th><th>source_id</th><th>title</th><th>chunks</th><th>captured_at (UTC)</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8"><em>No Gmail or Calendar captures retained yet.</em></td></tr>'}</tbody></table>
</body></html>`)
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}
